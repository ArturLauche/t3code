import {
  EnvironmentId,
  type CloudSandbox,
  type ExecutionEnvironmentCategory,
  type ExecutionEnvironmentContract,
  type ExecutionEnvironmentLifecycleState,
  type SandboxProviderKind,
  type SandboxProvisionOptions,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/**
 * The common execution environment abstraction. Every category — Local,
 * SSH Remote, Cloud Sandbox — is surfaced through this service so the rest of
 * T3 Code (orchestration, source control, GitHub integration, UI) never branches
 * on provider specifics. New cloud providers adapt to this contract behind an
 * adapter; nothing else changes.
 *
 * This intentionally reuses and generalizes the existing saved-environment and
 * remote-connection architecture rather than parallelizing it: SSH and cloud
 * adapters ultimately resolve to the same connection target (http/ws base URLs +
 * credential) the connection registry already consumes.
 */
export class ExecutionEnvironmentError extends Schema.TaggedErrorClass<ExecutionEnvironmentError>()(
  "ExecutionEnvironmentError",
  {
    operation: Schema.String,
    category: Schema.optionalKey(Schema.String),
    providerKind: Schema.optionalKey(Schema.String),
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Execution environment ${this.operation} failed: ${this.detail}`;
  }
}

/** Input shared by lifecycle operations that target a known environment. */
export interface ExecutionEnvironmentRef {
  readonly environmentId: EnvironmentId;
}

/** Result of provisioning/connecting an environment. */
export interface ResolvedExecutionEnvironment {
  readonly contract: ExecutionEnvironmentContract;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

/** Capabilities an environment adapter supports. */
export interface ExecutionEnvironmentAdapterCapabilities {
  readonly category: ExecutionEnvironmentCategory;
  readonly providerKind?: SandboxProviderKind;
  readonly create: boolean;
  readonly reconnect: boolean;
  readonly status: boolean;
  readonly start: boolean;
  readonly stop: boolean;
  readonly pause: boolean;
  readonly resume: boolean;
  readonly delete: boolean;
}

export interface ExecutionEnvironmentAdapter {
  readonly capabilities: ExecutionEnvironmentAdapterCapabilities;
  readonly resolve: (
    ref: ExecutionEnvironmentRef,
  ) => Effect.Effect<ExecutionEnvironmentContract, ExecutionEnvironmentError>;
  readonly connect: (
    ref: ExecutionEnvironmentRef,
  ) => Effect.Effect<ResolvedExecutionEnvironment, ExecutionEnvironmentError>;
  readonly create: (
    input: ExecutionEnvironmentProvisionInput,
  ) => Effect.Effect<ResolvedExecutionEnvironment, ExecutionEnvironmentError>;
  readonly status: (
    ref: ExecutionEnvironmentRef,
  ) => Effect.Effect<ExecutionEnvironmentLifecycleState, ExecutionEnvironmentError>;
  readonly start: (ref: ExecutionEnvironmentRef) => Effect.Effect<void, ExecutionEnvironmentError>;
  readonly stop: (ref: ExecutionEnvironmentRef) => Effect.Effect<void, ExecutionEnvironmentError>;
  readonly pause: (ref: ExecutionEnvironmentRef) => Effect.Effect<void, ExecutionEnvironmentError>;
  readonly resume: (ref: ExecutionEnvironmentRef) => Effect.Effect<void, ExecutionEnvironmentError>;
  readonly delete: (ref: ExecutionEnvironmentRef) => Effect.Effect<void, ExecutionEnvironmentError>;
}

export interface ExecutionEnvironmentProvisionInput {
  readonly label: string;
  readonly providerKind?: SandboxProviderKind;
  readonly options?: SandboxProvisionOptions;
  /** Reconnect to an existing sandbox id instead of creating a new one. */
  readonly existingSandboxId?: string;
  /** Associate the new environment with a project. */
  readonly projectId?: string;
}

/**
 * Registry of environment adapters keyed by category (+ provider kind for
 * cloud). The orchestration/UI layers resolve an adapter for a given saved
 * environment and operate through it uniformly.
 */
export class ExecutionEnvironmentRegistry extends Context.Service<
  ExecutionEnvironmentRegistry,
  {
    readonly registerAdapter: (adapter: ExecutionEnvironmentAdapter) => Effect.Effect<void>;
    readonly resolveAdapter: (input: {
      readonly category: ExecutionEnvironmentCategory;
      readonly providerKind?: SandboxProviderKind;
    }) => Effect.Effect<ExecutionEnvironmentAdapter, ExecutionEnvironmentError>;
    readonly listCloudSandboxes: Effect.Effect<ReadonlyArray<CloudSandbox>>;
    readonly provision: (
      input: ExecutionEnvironmentProvisionInput,
    ) => Effect.Effect<ResolvedExecutionEnvironment, ExecutionEnvironmentError>;
  }
>()("t3/executionEnvironment/ExecutionEnvironmentRegistry") {}

const adapterKey = (
  category: ExecutionEnvironmentCategory,
  providerKind?: SandboxProviderKind,
): string => (providerKind ? `${category}:${providerKind}` : category);

export const makeRegistry = Effect.gen(function* () {
  const adapters = new Map<string, ExecutionEnvironmentAdapter>();

  const errorFor = (
    operation: string,
    input: { readonly category?: ExecutionEnvironmentCategory; readonly providerKind?: SandboxProviderKind },
    detail: string,
  ): ExecutionEnvironmentError =>
    new ExecutionEnvironmentError({
      operation,
      detail,
      ...(input.category ? { category: input.category } : {}),
      ...(input.providerKind ? { providerKind: input.providerKind } : {}),
    });

  return ExecutionEnvironmentRegistry.of({
    registerAdapter: (adapter) =>
      Effect.sync(() => {
        adapters.set(adapterKey(adapter.capabilities.category, adapter.capabilities.providerKind), adapter);
      }),
    resolveAdapter: (input) =>
      Effect.gen(function* () {
        const adapter = adapters.get(adapterKey(input.category, input.providerKind));
        if (adapter === undefined) {
          return yield* Effect.fail(
            errorFor(
              "resolveAdapter",
              input,
              "No execution environment adapter is registered for this category/provider.",
            ),
          );
        }
        return adapter;
      }),
    listCloudSandboxes: Effect.sync(() => []),
    provision: (input) =>
      Effect.gen(function* () {
        const category: ExecutionEnvironmentCategory = input.providerKind ? "cloud" : "local";
        const adapterKeyVal = adapterKey(category, input.providerKind);
        const adapter = adapters.get(adapterKeyVal);
        if (adapter === undefined) {
          return yield* Effect.fail(
            errorFor(
              "provision",
              { category, ...(input.providerKind ? { providerKind: input.providerKind } : {}) },
              "No execution environment adapter is registered for this category/provider.",
            ),
          );
        }
        return yield* adapter.create(input);
      }),
  });
});

export const registryLayer = Layer.effect(ExecutionEnvironmentRegistry, makeRegistry);

/**
 * Build an {@link ExecutionEnvironmentContract} for a reachable remote
 * environment once a transport is established. Adapters call this with the
 * resolved base URL and descriptor; the descriptor fetch itself is owned by the
 * adapter's transport (SSH tunnel / HTTP), keeping this module dependency-free.
 */
export const buildRemoteContract = (input: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly category: ExecutionEnvironmentCategory;
  readonly providerKind?: SandboxProviderKind;
}): ExecutionEnvironmentContract => ({
  environmentId: input.environmentId,
  label: input.label,
  category: input.category,
  ...(input.providerKind ? { providerKind: input.providerKind } : {}),
  state: "running",
  httpBaseUrl: input.httpBaseUrl,
  wsBaseUrl: null,
});
