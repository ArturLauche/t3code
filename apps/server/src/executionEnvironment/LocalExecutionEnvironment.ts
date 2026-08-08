import { type ExecutionEnvironmentContract, type SandboxProvisionOptions } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  type ExecutionEnvironmentAdapter,
  type ExecutionEnvironmentAdapterCapabilities,
  type ExecutionEnvironmentProvisionInput,
  type ExecutionEnvironmentRef,
  type ResolvedExecutionEnvironment,
  ExecutionEnvironmentError,
} from "./ExecutionEnvironmentRegistry.ts";
import * as ServerConfig from "../config.ts";

/**
 * Local execution environment adapter.
 *
 * Local is the original T3 model: the machine running the T3 server owns the
 * files, git state, terminals and agent sessions. This adapter wraps the
 * existing {@link ServerEnvironment} service so Local participates in the common
 * execution environment abstraction without changing how local projects work.
 *
 * Lifecycle ops that don't apply to a local server (pause/resume/delete) return
 * a clear "unsupported" error rather than no-oping silently — the registry's
 * capabilities already advertise this, so well-behaved callers won't invoke them.
 */
const localCapabilities: ExecutionEnvironmentAdapterCapabilities = {
  category: "local",
  create: true,
  reconnect: true,
  status: true,
  start: false,
  stop: false,
  pause: false,
  resume: false,
  delete: false,
};

const unsupported = (
  operation: string,
): Effect.Effect<never, ExecutionEnvironmentError> =>
  Effect.fail(
    new ExecutionEnvironmentError({
      operation,
      category: "local",
      detail: "The local execution environment does not support this lifecycle operation.",
    }),
  );

export const makeLocalAdapter = Effect.gen(function* () {
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const serverConfig = yield* ServerConfig.ServerConfig;

  const localHttpBaseUrl = `http://${serverConfig.host ?? "localhost"}:${serverConfig.port}`;
  const localWsBaseUrl = `ws://${serverConfig.host ?? "localhost"}:${serverConfig.port}/ws`;

  const resolveContract = Effect.fn("LocalExecutionEnvironment.resolveContract")(function* () {
    const descriptor = yield* serverEnvironment.getDescriptor;
    const contract: ExecutionEnvironmentContract = {
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      category: "local",
      state: "running",
      httpBaseUrl: localHttpBaseUrl,
      wsBaseUrl: localWsBaseUrl,
    };
    return contract;
  });

  const adapter: ExecutionEnvironmentAdapter = {
    capabilities: localCapabilities,

    resolve: (_ref: ExecutionEnvironmentRef) => resolveContract(),

    connect: (_ref: ExecutionEnvironmentRef) =>
      Effect.gen(function* () {
        const contract = yield* resolveContract();
        return {
          contract,
          httpBaseUrl: localHttpBaseUrl,
          wsBaseUrl: localWsBaseUrl,
        } satisfies ResolvedExecutionEnvironment;
      }),

    create: (_input: ExecutionEnvironmentProvisionInput) =>
      Effect.gen(function* () {
        const contract = yield* resolveContract();
        return {
          contract,
          httpBaseUrl: localHttpBaseUrl,
          wsBaseUrl: localWsBaseUrl,
        } satisfies ResolvedExecutionEnvironment;
      }),

    status: () => Effect.succeed("running"),

    start: () => unsupported("start"),
    stop: () => unsupported("stop"),
    pause: () => unsupported("pause"),
    resume: () => unsupported("resume"),
    delete: () => unsupported("delete"),
  };

  return adapter;
});

/** Local provisioning options are ignored — the local server is the environment. */
export type LocalProvisionOptions = SandboxProvisionOptions;
