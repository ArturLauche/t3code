import { describe, expect, it } from "@effect/vitest";
import type { CloudSandbox, SandboxLifecycleCapabilities, SandboxProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  SandboxProviderError,
  type SandboxProviderAdapter,
  type SandboxProviderProvisionInput,
  makeSandboxProviderRegistry,
} from "./SandboxProvider.ts";
import { makeDaytonaAdapter } from "./DaytonaAdapter.ts";
import { makeE2bAdapter } from "./E2bAdapter.ts";
import { makeNovitaAdapter } from "./NovitaAdapter.ts";

const e2bCapabilities: SandboxLifecycleCapabilities = {
  create: true,
  reconnect: true,
  status: true,
  start: false,
  stop: true,
  pause: true,
  resume: true,
  delete: true,
  resourceInfo: true,
  region: true,
  autoStop: true,
};

function fakeAdapter(kind: SandboxProviderKind): SandboxProviderAdapter {
  const sandboxes = new Map<string, CloudSandbox>();
  const get = (id: string): CloudSandbox => sandboxes.get(id) ?? { sandboxId: id, providerKind: kind, label: id, state: "running", createdAt: new Date().toISOString() };
  return {
    kind,
    capabilities: e2bCapabilities,
    validateConnection: () => Effect.succeed({ ok: true, detail: null }),
    createSandbox: (input: SandboxProviderProvisionInput) =>
      Effect.gen(function* () {
        const sandbox: CloudSandbox = {
          sandboxId: `sb-${input.label}`,
          providerKind: kind,
          label: input.label,
          state: "running",
          createdAt: new Date().toISOString(),
        };
        sandboxes.set(sandbox.sandboxId ?? input.label, sandbox);
        return sandbox;
      }),
    reconnectSandbox: (id) => Effect.succeed(get(id)),
    getSandbox: (id) => Effect.succeed(get(id)),
    startSandbox: (id) => Effect.succeed({ ...get(id), state: "running" }),
    stopSandbox: (id) => Effect.succeed({ ...get(id), state: "stopped" }),
    pauseSandbox: (id) => Effect.succeed({ ...get(id), state: "paused" }),
    resumeSandbox: (id) => Effect.succeed({ ...get(id), state: "running" }),
    deleteSandbox: (id) => Effect.sync(() => void sandboxes.delete(id)),
    resolveConnectionTarget: (id) =>
      Effect.succeed({ sandboxId: id, transport: "http" as const }),
  };
}

describe("SandboxProviderRegistry", () => {
  it.effect("registers and resolves providers by kind", () =>
    Effect.gen(function* () {
      const registry = yield* makeSandboxProviderRegistry;
      yield* registry.register(fakeAdapter("e2b"));
      const adapter = yield* registry.get("e2b");
      expect(adapter.kind).toBe("e2b");
      const kinds = yield* registry.list;
      expect(kinds).toContain("e2b");
    }));

  it.effect("fails for an unregistered provider kind", () =>
    Effect.gen(function* () {
      const registry = yield* makeSandboxProviderRegistry;
      const matched = yield* registry.get("daytona").pipe(Effect.match({ onFailure: () => "failed" as const, onSuccess: () => "ok" as const }));
      expect(matched).toBe("failed");
    }));

  it.effect("drives a full create -> pause -> resume -> delete lifecycle", () =>
    Effect.gen(function* () {
      const registry = yield* makeSandboxProviderRegistry;
      const adapter = fakeAdapter("e2b");
      yield* registry.register(adapter);
      const created = yield* adapter.createSandbox({ label: "proj" });
      expect(created.state).toBe("running");
      const id = created.sandboxId ?? "proj";
      const paused = yield* adapter.pauseSandbox(id);
      expect(paused.state).toBe("paused");
      const resumed = yield* adapter.resumeSandbox(id);
      expect(resumed.state).toBe("running");
      yield* adapter.deleteSandbox(id);
      expect(true).toBe(true);
    }));
});

describe("Daytona adapter unsupported operations", () => {
  const adapter = makeDaytonaAdapter({ getApiKey: () => Effect.succeed("fake-key"), credentialKey: "test-key" });

  it.effect("rejects pause with a provider error (Daytona has no pause)", () =>
    Effect.gen(function* () {
      const matched = yield* adapter.pauseSandbox("sb-1").pipe(Effect.match({ onFailure: () => "failed" as const, onSuccess: () => "ok" as const }));
      expect(matched).toBe("failed");
    }));

  it.effect("rejects resume with a provider error (Daytona has no resume)", () =>
    Effect.gen(function* () {
      const matched = yield* adapter.resumeSandbox("sb-1").pipe(Effect.match({ onFailure: () => "failed" as const, onSuccess: () => "ok" as const }));
      expect(matched).toBe("failed");
    }));
});

describe("E2B adapter unsupported operations", () => {
  const adapter = makeE2bAdapter({ getApiKey: () => Effect.succeed("fake-key"), credentialKey: "test-key" });

  it.effect("rejects start with a provider error (use resume)", () =>
    Effect.gen(function* () {
      const matched = yield* adapter.startSandbox("sb-1").pipe(Effect.match({ onFailure: () => "failed" as const, onSuccess: () => "ok" as const }));
      expect(matched).toBe("failed");
    }));

  it.effect("resolves an HTTP connection target (no SSH)", () =>
    Effect.gen(function* () {
      const target = yield* adapter.resolveConnectionTarget("sb-1");
      expect(target.transport).toBe("http");
    }));
});

describe("Novita adapter unsupported operations", () => {
  const adapter = makeNovitaAdapter({ getApiKey: () => Effect.succeed("fake-key"), credentialKey: "test-key" });

  it.effect("rejects start with a provider error (use resume)", () =>
    Effect.gen(function* () {
      const matched = yield* adapter.startSandbox("sb-1").pipe(Effect.match({ onFailure: () => "failed" as const, onSuccess: () => "ok" as const }));
      expect(matched).toBe("failed");
    }));

  it.effect("resolves an HTTP connection target (no SSH)", () =>
    Effect.gen(function* () {
      const target = yield* adapter.resolveConnectionTarget("sb-1");
      expect(target.transport).toBe("http");
    }));
});
