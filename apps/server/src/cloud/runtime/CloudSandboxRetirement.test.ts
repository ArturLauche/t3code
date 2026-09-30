import { CloudRuntimeId, EnvironmentId } from "@t3tools/contracts";
import type { CloudSandboxSummary } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { cloudRuntimeCredentialName } from "./credentialName.ts";
import { retireCloudRuntimes, type CloudRuntimeConfigs } from "./CloudSandboxRetirement.ts";
import type { CloudVendorAdapter } from "./VendorAdapter.ts";

const environmentId = EnvironmentId.make("retirement-environment");
const runtimeId = CloudRuntimeId.make("primary");
const encoder = new TextEncoder();

type VendorCall = { readonly method: string; readonly value?: unknown };

const managedSandbox = (sandboxId: string, owner: string): CloudSandboxSummary =>
  ({
    runtimeId,
    kind: "e2b",
    sandboxId,
    name: null,
    state: "running",
    createdAt: "2026-09-29T00:00:00.000Z",
    metadata: {
      t3ManagedExecution: "true",
      t3RuntimeId: runtimeId,
      t3EnvironmentId: owner,
    },
  }) satisfies CloudSandboxSummary;

const makeVendor = (calls: Array<VendorCall>): CloudVendorAdapter => ({
  kind: "e2b",
  listSandboxes: async () => [
    managedSandbox("owned", environmentId),
    // Neither is this environment's to delete: one belongs to another T3
    // environment sharing the vendor account, the other is not a T3 sandbox.
    managedSandbox("other-environment", EnvironmentId.make("someone-else")),
    { ...managedSandbox("unmanaged", environmentId), metadata: { team: "someone else" } },
  ],
  createSandbox: async () => managedSandbox("created", environmentId),
  execute: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  startProcess: async () => {
    throw new Error("not used");
  },
  action: async (sandboxId, action) => {
    calls.push({ method: "action", value: { sandboxId, action } });
  },
  uploadFile: async () => undefined,
  downloadFile: async () => new Uint8Array(),
  close: async () => {
    calls.push({ method: "close" });
  },
});

const e2b = (overrides: Record<string, unknown> = {}): CloudRuntimeConfigs => ({
  [runtimeId]: { kind: "e2b", enabled: true, setupCommands: [], ...overrides },
});

const credentialReader = (ids: ReadonlyArray<CloudRuntimeId>) => (id: CloudRuntimeId) =>
  Effect.succeed(ids.includes(id) ? "old-account-key" : "");

const retire = (
  previous: CloudRuntimeConfigs,
  next: CloudRuntimeConfigs,
  calls: Array<VendorCall>,
  withKeys: ReadonlyArray<CloudRuntimeId> = [runtimeId],
) =>
  retireCloudRuntimes(previous, next, {
    environmentId,
    readCredential: credentialReader(withKeys),
    makeVendor: () => makeVendor(calls),
  });

it.effect("deletes only the sandboxes a removed runtime can no longer reach", () =>
  Effect.gen(function* () {
    const calls: Array<VendorCall> = [];
    yield* retire(e2b(), {}, calls);
    assert.deepEqual(calls, [
      { method: "action", value: { sandboxId: "owned", action: "delete" } },
      { method: "close" },
    ]);
  }),
);

it.effect("retires sandboxes when a runtime is repointed at another vendor", () =>
  Effect.gen(function* () {
    const calls: Array<VendorCall> = [];
    yield* retire(e2b(), e2b({ kind: "daytona" }), calls);
    assert.deepEqual(calls, [
      { method: "action", value: { sandboxId: "owned", action: "delete" } },
      { method: "close" },
    ]);
  }),
);

it.effect("leaves a runtime alone while its vendor identity is unchanged", () =>
  Effect.gen(function* () {
    const calls: Array<VendorCall> = [];
    yield* retire(
      e2b(),
      e2b({ enabled: false, displayName: "Renamed", setupCommands: ["npm install"] }),
      calls,
    );
    assert.deepEqual(calls, []);
  }),
);

it.effect("does nothing when the runtime has no credential left", () =>
  Effect.gen(function* () {
    const calls: Array<VendorCall> = [];
    yield* retireCloudRuntimes(
      e2b(),
      {},
      {
        environmentId,
        readCredential: () => Effect.succeed(""),
        makeVendor: () => makeVendor(calls),
      },
    );
    assert.deepEqual(calls, []);
  }),
);

it.effect("retires each runtime independently of the others", () =>
  Effect.gen(function* () {
    const other = CloudRuntimeId.make("secondary");
    const calls: Array<VendorCall> = [];
    // `secondary` never had a credential, so there is nothing to reach it
    // with; that must not stop the runtime that did.
    yield* retire(
      {
        [runtimeId]: { kind: "e2b", enabled: true, setupCommands: [] },
        [other]: { kind: "e2b", enabled: true, setupCommands: [] },
      },
      {},
      calls,
      [runtimeId],
    );
    assert.deepEqual(calls, [
      { method: "action", value: { sandboxId: "owned", action: "delete" } },
      { method: "close" },
    ]);
  }),
);
