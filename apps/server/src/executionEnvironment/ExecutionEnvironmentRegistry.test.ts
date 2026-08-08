import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  type ExecutionEnvironmentAdapter,
  type ExecutionEnvironmentAdapterCapabilities,
  type ExecutionEnvironmentProvisionInput,
  type ResolvedExecutionEnvironment,
  makeRegistry,
  buildRemoteContract,
} from "./ExecutionEnvironmentRegistry.ts";

const localCapabilities: ExecutionEnvironmentAdapterCapabilities = {
  category: "local",
  create: true,
  reconnect: false,
  status: true,
  start: false,
  stop: false,
  pause: false,
  resume: false,
  delete: false,
};

function stubAdapter(
  capabilities: ExecutionEnvironmentAdapterCapabilities,
  createImpl: (input: ExecutionEnvironmentProvisionInput) => Effect.Effect<ResolvedExecutionEnvironment>,
): ExecutionEnvironmentAdapter {
  return {
    capabilities,
    resolve: () => Effect.die("not implemented"),
    connect: () => Effect.die("not implemented"),
    create: createImpl,
    status: () => Effect.succeed("running"),
    start: () => Effect.die("not implemented"),
    stop: () => Effect.die("not implemented"),
    pause: () => Effect.die("not implemented"),
    resume: () => Effect.die("not implemented"),
    delete: () => Effect.die("not implemented"),
  };
}

function localResolved(label: string): ResolvedExecutionEnvironment {
  return {
    contract: {
      environmentId: "local-1" as never,
      label,
      category: "local",
      state: "running",
      httpBaseUrl: "http://127.0.0.1:3000",
    },
    httpBaseUrl: "http://127.0.0.1:3000",
    wsBaseUrl: "",
  };
}

describe("ExecutionEnvironmentRegistry", () => {
  it.effect("resolves a registered local adapter", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry;
      yield* registry.registerAdapter(stubAdapter(localCapabilities, (input) => Effect.succeed(localResolved(input.label))));
      const adapter = yield* registry.resolveAdapter({ category: "local" });
      expect(adapter.capabilities.category).toBe("local");
    }));

  it.effect("fails when no adapter is registered for the requested category", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry;
      const matched = yield* registry
        .resolveAdapter({ category: "ssh-remote" })
        .pipe(Effect.match({ onFailure: () => "failed" as const, onSuccess: () => "ok" as const }));
      expect(matched).toBe("failed");
    }));

  it.effect("routes provision to the local adapter when no provider kind is given", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry;
      yield* registry.registerAdapter(stubAdapter(localCapabilities, (input) => Effect.succeed(localResolved(input.label))));
      const resolved = yield* registry.provision({ label: "local-project" });
      expect(resolved.contract.category).toBe("local");
      expect(resolved.contract.label).toBe("local-project");
    }));

  it("builds a remote contract with the provided httpBaseUrl", () => {
    const contract = buildRemoteContract({
      environmentId: "ssh:host" as never,
      label: "host",
      httpBaseUrl: "http://127.0.0.1:4000",
      category: "ssh-remote",
    });
    expect(contract.httpBaseUrl).toBe("http://127.0.0.1:4000");
    expect(contract.wsBaseUrl).toBeNull();
    expect(contract.category).toBe("ssh-remote");
  });

  it.effect("exposes an empty cloud sandbox list by default", () =>
    Effect.gen(function* () {
      const registry = yield* makeRegistry;
      const sandboxes = yield* registry.listCloudSandboxes;
      expect(sandboxes).toEqual([]);
    }));
});

