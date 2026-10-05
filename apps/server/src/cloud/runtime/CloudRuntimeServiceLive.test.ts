import { CloudRuntimeId, EnvironmentId, type CloudSandboxSummary } from "@t3tools/contracts";
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

type RecordedCall = { readonly method: string; readonly value?: unknown };

/**
 * A vendor that keeps the sandboxes it created, so preparation reuse is
 * exercised against real round trips instead of a hard-coded metadata blob:
 * the reuse predicate keys on the setup hash the server stamps on create.
 */
const makeVendor = (input: {
  readonly calls: Array<RecordedCall>;
  readonly listError?: Error;
  readonly metadata?: Record<string, string>;
  readonly exitCode?: { current: number };
  /** Mutable so a test can age the sandbox a preparation is about to find. */
  readonly state?: { current: "running" | "paused" | "stopped" | "error" | "unknown" };
}): CloudVendorAdapter => {
  const sandboxes: Array<CloudSandboxSummary> = [
    {
      runtimeId,
      kind: "e2b",
      sandboxId: "sandbox-1",
      name: "T3 sandbox",
      state: input.state?.current ?? "running",
      createdAt: "2026-09-24T00:00:00.000Z",
      metadata: input.metadata ?? {
        t3ManagedExecution: "true",
        t3RuntimeId: runtimeId,
        t3EnvironmentId: environmentId,
      },
    },
  ];
  let created = 0;
  return {
    kind: "e2b",
    listSandboxes: async () => {
      input.calls.push({ method: "listSandboxes" });
      if (input.listError) throw input.listError;
      // The state holder is authoritative, so a test can age a sandbox between
      // two preparations the way a vendor would.
      return sandboxes.map((sandbox) => ({
        ...sandbox,
        ...(input.state ? { state: input.state.current } : {}),
      }));
    },
    createSandbox: async (create) => {
      created += 1;
      input.calls.push({ method: "createSandbox", value: create });
      const summary: CloudSandboxSummary = {
        runtimeId,
        kind: "e2b",
        sandboxId: `sandbox-created-${created}`,
        name: create.name ?? null,
        state: input.state?.current ?? "running",
        createdAt: "2026-09-24T00:00:00.000Z",
        // The real vendors stamp the ownership metadata themselves; the reuse
        // predicate depends on it, so the fake has to as well.
        metadata: {
          ...create.metadata,
          t3ManagedExecution: "true",
          t3RuntimeId: runtimeId,
          t3EnvironmentId: environmentId,
        },
      };
      sandboxes.push(summary);
      return summary;
    },
    execute: async (sandboxId, command) => {
      input.calls.push({ method: "execute", value: { sandboxId, command } });
      return { exitCode: input.exitCode?.current ?? 0, stdout: "ok", stderr: "" };
    },
    startProcess: async () => new CloudProcess(),
    action: async (sandboxId, action) => {
      input.calls.push({ method: "action", value: { sandboxId, action } });
      if (action === "delete") {
        const index = sandboxes.findIndex((sandbox) => sandbox.sandboxId === sandboxId);
        if (index >= 0) sandboxes.splice(index, 1);
      }
    },
    uploadFile: async () => undefined,
    downloadFile: async () => new Uint8Array(),
  };
};

const makeService = (
  vendor: CloudVendorAdapter,
  serviceEnvironmentId: EnvironmentId = environmentId,
  runtime: { readonly enabled?: boolean; readonly setupCommands?: ReadonlyArray<string> } = {},
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
              enabled: runtime.enabled ?? true,
              setupCommands: runtime.setupCommands ?? [],
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
      assert.isTrue(created.sandboxes.some((sandbox) => sandbox.name === "thread-sandbox"));
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

  it.effect("keeps a disabled runtime's paid sandboxes manageable", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; value?: unknown }> = [];
      const service = yield* makeService(makeVendor({ calls }), environmentId, { enabled: false });
      yield* service.setCredential({ runtimeId, apiKey: "secret-api-key" });
      calls.length = 0;

      // Disabling a runtime must not strand sandboxes that keep billing, so
      // enumerating and managing them has to keep reaching the vendor.
      const listed = yield* service.list();
      assert.equal(listed.runtimes[0]?.health.status, "disabled");
      assert.equal(listed.runtimes[0]?.sandboxes.length, 1);
      // The disabled-runtime enumeration is a second path into the same
      // client-visible shape, so it redacts exactly like the enabled one.
      assert.deepEqual(listed.runtimes[0]?.sandboxes[0]?.metadata, {
        t3ManagedExecution: "true",
        t3RuntimeId: runtimeId,
        t3EnvironmentId: environmentId,
      });
      const deleted = yield* service.sandboxAction({
        runtimeId,
        sandboxId: "sandbox-1",
        action: "delete",
      });
      assert.equal(deleted.sandboxes.length, 0);
      assert.isTrue(
        calls.some(
          ({ method, value }) =>
            method === "action" && (value as { action: string }).action === "delete",
        ),
      );
    }),
  );

  it.effect("refuses to execute on a disabled runtime", () =>
    Effect.gen(function* () {
      const service = yield* makeService(makeVendor({ calls: [] }), environmentId, {
        enabled: false,
      });
      yield* service.setCredential({ runtimeId, apiKey: "secret-api-key" });
      for (const error of [
        yield* Effect.flip(
          service.execute({
            runtimeId,
            sandboxId: "sandbox-1",
            command: "printf ok",
            timeoutSeconds: 30,
          }),
        ),
        yield* Effect.flip(service.prepareExecution({ runtimeId, name: "T3 sandbox" })),
        yield* Effect.flip(
          service.startProcess(runtimeId, "sandbox-1", {
            command: "codex",
            args: [],
            env: {},
            timeoutSeconds: 30,
          }),
        ),
        yield* Effect.flip(service.createSandbox({ runtimeId, name: "new-sandbox" })),
        yield* Effect.flip(service.test({ runtimeId })),
      ]) {
        assert.equal(error.reason, "runtime_disabled");
      }
    }),
  );

  it.effect.each(["stopped", "error", "unknown"] as const)(
    "does not reuse a preparation sandbox in the %s state",
    (unusableState) =>
      Effect.gen(function* () {
        const calls: Array<RecordedCall> = [];
        const state: { current: "running" | "paused" | "stopped" | "error" | "unknown" } = {
          current: "running",
        };
        const service = yield* makeService(makeVendor({ calls, state }));
        yield* service.setCredential({ runtimeId, apiKey: "secret-api-key" });
        const first = yield* service.prepareExecution({
          runtimeId,
          name: "T3 sandbox",
          metadata: { t3ProviderInstanceId: "provider-1" },
        });
        // `unknown` means this server did not recognise the vendor's state
        // string, which must fail closed rather than run a turn on it.
        state.current = unusableState;
        const second = yield* service.prepareExecution({
          runtimeId,
          name: "T3 sandbox",
          metadata: { t3ProviderInstanceId: "provider-1" },
        });
        assert.notEqual(second.sandboxId, first.sandboxId);
      }),
  );

  it.effect("resumes and reuses a paused preparation sandbox", () =>
    Effect.gen(function* () {
      const calls: Array<RecordedCall> = [];
      const state: { current: "running" | "paused" | "stopped" | "error" | "unknown" } = {
        current: "paused",
      };
      const service = yield* makeService(makeVendor({ calls, state }));
      yield* service.setCredential({ runtimeId, apiKey: "secret-api-key" });
      const first = yield* service.prepareExecution({
        runtimeId,
        name: "T3 sandbox",
        metadata: { t3ProviderInstanceId: "provider-1" },
      });
      calls.length = 0;
      const second = yield* service.prepareExecution({
        runtimeId,
        name: "T3 sandbox",
        metadata: { t3ProviderInstanceId: "provider-1" },
      });
      assert.equal(second.sandboxId, first.sandboxId);
      assert.deepEqual(
        calls.filter(({ method }) => method === "action").map(({ value }) => value),
        [{ sandboxId: first.sandboxId, action: "resume" }],
      );
      assert.isFalse(calls.some(({ method }) => method === "createSandbox"));
    }),
  );

  it.effect("deletes a sandbox it created when setup fails", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; value?: unknown }> = [];
      const service = yield* makeService(
        makeVendor({ calls, exitCode: { current: 3 } }),
        environmentId,
        { setupCommands: ["npm install"] },
      );
      yield* service.setCredential({ runtimeId, apiKey: "secret-api-key" });
      calls.length = 0;
      const error = yield* Effect.flip(
        service.prepareExecution({ runtimeId, name: "brand-new", metadata: {} }),
      );
      assert.equal(error.reason, "operation_failed");
      assert.isTrue(
        calls.some(
          ({ method, value }) =>
            method === "action" && (value as { action: string }).action === "delete",
        ),
        "a sandbox this call created must not be left billing after a failed setup",
      );
    }),
  );

  it.effect("keeps a reused sandbox when a later setup step fails", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; value?: unknown }> = [];
      const exitCode = { current: 0 };
      const service = yield* makeService(makeVendor({ calls, exitCode }), environmentId, {
        setupCommands: ["npm install"],
      });
      yield* service.setCredential({ runtimeId, apiKey: "secret-api-key" });
      const first = yield* service.prepareExecution({
        runtimeId,
        name: "T3 sandbox",
        metadata: { t3ProviderInstanceId: "provider-1" },
      });
      exitCode.current = 3;
      calls.length = 0;
      yield* Effect.flip(
        service.prepareExecution({
          runtimeId,
          name: "T3 sandbox",
          metadata: { t3ProviderInstanceId: "provider-1" },
        }),
      );
      assert.isDefined(first.sandboxId);
      assert.isFalse(
        calls.some(({ method }) => method === "action"),
        "a sandbox this call only borrowed belongs to the next turn, not to this failure",
      );
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
