import { CloudRuntimeId, EnvironmentId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { CloudProcess } from "./CloudProcess.ts";
import { makeCloudRuntimeService } from "./CloudRuntimeServiceLive.ts";
import type { CloudVendorAdapter } from "./VendorAdapter.ts";

const runtimeId = CloudRuntimeId.make("primary");
const environmentId = EnvironmentId.make("test-environment");

const makeSecretStore = () => {
  const values = new Map<string, Uint8Array>();
  return {
    values,
    layer: Layer.succeed(
      ServerSecretStore,
      ServerSecretStore.of({
        get: (name) => Effect.succeed(Option.fromUndefinedOr(values.get(name))),
        set: (name, value) =>
          Effect.sync(() => {
            values.set(name, value);
          }),
        create: (name, value) =>
          Effect.sync(() => {
            if (values.has(name)) throw new Error("secret already exists");
            values.set(name, value);
          }),
        getOrCreateRandom: (name) =>
          Effect.sync(() => {
            const existing = values.get(name) ?? new Uint8Array([1]);
            values.set(name, existing);
            return existing;
          }),
        remove: (name) =>
          Effect.sync(() => {
            values.delete(name);
          }),
      }),
    ),
  };
};

const makeVendor = (input: {
  readonly calls: Array<{ readonly method: string; readonly value?: unknown }>;
  readonly listError?: Error;
  readonly metadata?: Record<string, string>;
}): CloudVendorAdapter => ({
  kind: "e2b",
  listSandboxes: async () => {
    input.calls.push({ method: "listSandboxes" });
    if (input.listError) throw input.listError;
    return [
      {
        runtimeId,
        kind: "e2b",
        sandboxId: "sandbox-1",
        name: "T3 sandbox",
        state: "running",
        createdAt: "2026-09-24T00:00:00.000Z",
        metadata: input.metadata ?? {
          t3ManagedExecution: "true",
          t3RuntimeId: runtimeId,
          t3EnvironmentId: environmentId,
        },
      },
    ];
  },
  createSandbox: async (create) => {
    input.calls.push({ method: "createSandbox", value: create });
    return {
      runtimeId,
      kind: "e2b",
      sandboxId: "sandbox-2",
      name: create.name ?? null,
      state: "running",
      createdAt: "2026-09-24T00:00:00.000Z",
    };
  },
  execute: async (sandboxId, command) => {
    input.calls.push({ method: "execute", value: { sandboxId, command } });
    return { exitCode: 0, stdout: "ok", stderr: "" };
  },
  startProcess: async () => new CloudProcess(),
  action: async (sandboxId, action) => {
    input.calls.push({ method: "action", value: { sandboxId, action } });
  },
  uploadFile: async () => undefined,
  downloadFile: async () => new Uint8Array(),
});

const makeService = (
  vendor: CloudVendorAdapter,
  serviceEnvironmentId: EnvironmentId = environmentId,
) => {
  const secrets = makeSecretStore();
  return Effect.provide(
    makeCloudRuntimeService({
      makeVendor: () => vendor,
    }),
    Layer.merge(
      Layer.succeed(
        ServerEnvironment.ServerEnvironmentIdentity,
        ServerEnvironment.ServerEnvironmentIdentity.of({
          getEnvironmentId: Effect.succeed(serviceEnvironmentId),
        }),
      ),
      Layer.merge(
        ServerSettingsService.layerTest({
          cloudRuntimeInstances: {
            [runtimeId]: {
              kind: "e2b",
              enabled: true,
              setupCommands: [],
            },
          },
        }),
        secrets.layer,
      ),
    ),
  );
};

describe("CloudRuntimeServiceLive", () => {
  it.effect("keeps credentials in ServerSecretStore and exposes only presence", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; value?: unknown }> = [];
      const service = yield* makeService(makeVendor({ calls }));
      const before = yield* service.list();
      assert.equal(before.runtimes[0]?.hasCredential, false);
      assert.equal(before.runtimes[0]?.health.status, "unconfigured");
      assert.deepEqual(calls, []);

      const after = yield* service.setCredential({ runtimeId, apiKey: "secret-api-key" });
      assert.equal(after.runtimes[0]?.hasCredential, true);
      assert.equal(after.runtimes[0]?.health.status, "ready");
      assert.notInclude(String(after), "secret-api-key");
      assert.deepEqual(calls, [{ method: "listSandboxes" }]);

      const cleared = yield* service.clearCredential(runtimeId);
      assert.equal(cleared.runtimes[0]?.hasCredential, false);
      assert.equal(
        yield* service
          .clearCredential(runtimeId)
          .pipe(Effect.map((value) => value.runtimes.length)),
        1,
      );
    }),
  );

  it.effect("does not expose sandboxes owned by another T3 environment", () =>
    Effect.gen(function* () {
      const service = yield* makeService(
        makeVendor({ calls: [] }),
        EnvironmentId.make("other-environment"),
      );
      yield* service.setCredential({ runtimeId, apiKey: "secret-api-key" });
      const result = yield* service.list();
      assert.equal(result.runtimes[0]?.sandboxes.length, 0);
    }),
  );

  it.effect("delegates lifecycle and command operations to the selected vendor", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; value?: unknown }> = [];
      const service = yield* makeService(makeVendor({ calls }));
      yield* service.setCredential({ runtimeId, apiKey: "secret-api-key" });
      calls.length = 0;

      const created = yield* service.createSandbox({ runtimeId, name: "thread-sandbox" });
      assert.equal(
        created.sandboxes.some((sandbox) => sandbox.name === "thread-sandbox"),
        false,
      );
      const actionResult = yield* service.sandboxAction({
        runtimeId,
        sandboxId: "sandbox-1",
        action: "pause",
      });
      assert.equal(actionResult.sandboxes[0]?.state, "running");
      const execution = yield* service.execute({
        runtimeId,
        sandboxId: "sandbox-1",
        command: "printf ok",
        timeoutSeconds: 30,
      });
      assert.deepEqual(execution, { exitCode: 0, stdout: "ok", stderr: "" });

      assert.deepEqual(
        calls.map(({ method }) => method),
        [
          "createSandbox",
          "listSandboxes",
          "listSandboxes",
          "action",
          "listSandboxes",
          "listSandboxes",
          "execute",
        ],
      );
    }),
  );

  it.effect("rejects lifecycle actions for sandboxes outside the runtime", () =>
    Effect.gen(function* () {
      const service = yield* makeService(makeVendor({ calls: [] }));
      yield* service.setCredential({ runtimeId, apiKey: "secret-api-key" });
      const error = yield* Effect.flip(
        service.sandboxAction({
          runtimeId,
          sandboxId: "not-owned",
          action: "pause",
        }),
      );
      assert.equal(error.reason, "sandbox_not_found");
    }),
  );

  it.effect("rejects lifecycle operations for an untrusted sandbox label", () =>
    Effect.gen(function* () {
      const service = yield* makeService(
        makeVendor({ calls: [], metadata: { t3RuntimeId: runtimeId } }),
      );
      yield* service.setCredential({ runtimeId, apiKey: "secret-api-key" });
      const error = yield* Effect.flip(
        service.sandboxAction({
          runtimeId,
          sandboxId: "sandbox-1",
          action: "pause",
        }),
      );
      assert.equal(error.reason, "sandbox_not_found");
    }),
  );

  it.effect("rejects process starts for sandboxes outside the runtime", () =>
    Effect.gen(function* () {
      const service = yield* makeService(makeVendor({ calls: [] }));
      yield* service.setCredential({ runtimeId, apiKey: "secret-api-key" });
      const error = yield* Effect.flip(
        service.startProcess(runtimeId, "not-owned", {
          command: "codex",
          args: [],
          env: {},
          timeoutSeconds: 30,
        }),
      );
      assert.equal(error.reason, "sandbox_not_found");
    }),
  );

  it.effect("does not reuse a preparation sandbox owned by another runtime", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; value?: unknown }> = [];
      const service = yield* makeService(
        makeVendor({
          calls,
          metadata: {
            t3ManagedExecution: "true",
            t3RuntimeId: "other-runtime",
          },
        }),
      );
      yield* service.setCredential({ runtimeId, apiKey: "secret-api-key" });
      const handle = yield* service.prepareExecution({
        runtimeId,
        name: "T3 sandbox",
        metadata: { t3ProviderInstanceId: "provider-1" },
      });
      assert.equal(handle.sandboxId, "sandbox-2");
      assert.isTrue(calls.some(({ method }) => method === "createSandbox"));
    }),
  );

  it.effect("filters arbitrary sandbox metadata from client responses", () =>
    Effect.gen(function* () {
      const service = yield* makeService(
        makeVendor({
          calls: [],
          metadata: {
            t3ManagedExecution: "true",
            t3RuntimeId: runtimeId,
            t3EnvironmentId: environmentId,
            t3ProviderInstanceId: "provider-1",
            secret: "do-not-return",
          },
        }),
      );
      yield* service.setCredential({ runtimeId, apiKey: "secret-api-key" });
      const result = yield* service.list();
      assert.deepEqual(result.runtimes[0]?.sandboxes[0]?.metadata, {
        t3ManagedExecution: "true",
        t3RuntimeId: runtimeId,
        t3EnvironmentId: environmentId,
        t3ProviderInstanceId: "provider-1",
      });
    }),
  );

  it.effect("redacts the API key from vendor failures", () =>
    Effect.gen(function* () {
      const service = yield* makeService(
        makeVendor({ calls: [], listError: new Error("request failed for secret-api-key") }),
      );
      yield* service.setCredential({ runtimeId, apiKey: "secret-api-key" });
      const result = yield* service.list();
      assert.equal(result.runtimes[0]?.health.status, "error");
      assert.notInclude(result.runtimes[0]?.health.message ?? "", "secret-api-key");
      assert.include(result.runtimes[0]?.health.message ?? "", "[redacted]");
    }),
  );
});
