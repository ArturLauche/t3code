import {
  type CloudSandbox,
  type SandboxLifecycleCapabilities,
  type SandboxProviderKind,
  type SandboxProviderValidationResult,
  type SandboxProvisionOptions,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/**
 * Sandbox provider adapter interface. Each cloud provider (Daytona, E2B, Novita,
 * ...) implements this behind its own module so additional providers can be
 * added without modifying the rest of T3 Code. The adapter translates the
 * provider's real SDK/API capabilities into the common
 * {@link ExecutionEnvironmentAdapter} contract.
 *
 * API keys are never held by the adapter directly. They are resolved per-call
 * from the secure credential store via {@link SandboxProviderCredentialStore},
 * so a provider instance never materializes a secret in config, logs, or URLs.
 */
export class SandboxProviderError extends Schema.TaggedErrorClass<SandboxProviderError>()(
  "SandboxProviderError",
  {
    providerKind: Schema.String,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Sandbox provider ${this.providerKind} failed in ${this.operation}: ${this.detail}`;
  }
}

export interface SandboxProviderProvisionInput {
  readonly label: string;
  readonly options?: SandboxProvisionOptions;
  readonly existingSandboxId?: string;
  readonly projectId?: string;
}

/** Connection target produced by a provider once a sandbox is reachable. */
export interface SandboxConnectionTarget {
  readonly sandboxId: string;
  /** Transport hint the environment layer uses to bridge into T3. */
  readonly transport: "ssh" | "http" | "websocket";
  /** For ssh transport, the SSH target to hand to the existing SSH bootstrap. */
  readonly sshTarget?: {
    readonly alias: string;
    readonly hostname: string;
    readonly username: string | null;
    readonly port: number | null;
  };
  /** For http/websocket transport, the exposed service URL(s). */
  readonly httpBaseUrl?: string;
  readonly wsBaseUrl?: string;
}

export interface SandboxProviderAdapter {
  readonly kind: SandboxProviderKind;
  readonly capabilities: SandboxLifecycleCapabilities;
  /** Validate the stored API key reaches the provider. */
  readonly validateConnection: () => Effect.Effect<SandboxProviderValidationResult, SandboxProviderError>;
  readonly createSandbox: (
    input: SandboxProviderProvisionInput,
  ) => Effect.Effect<CloudSandbox, SandboxProviderError>;
  readonly reconnectSandbox: (
    sandboxId: string,
  ) => Effect.Effect<CloudSandbox, SandboxProviderError>;
  readonly getSandbox: (sandboxId: string) => Effect.Effect<CloudSandbox, SandboxProviderError>;
  readonly startSandbox: (sandboxId: string) => Effect.Effect<CloudSandbox, SandboxProviderError>;
  readonly stopSandbox: (sandboxId: string) => Effect.Effect<CloudSandbox, SandboxProviderError>;
  readonly pauseSandbox: (sandboxId: string) => Effect.Effect<CloudSandbox, SandboxProviderError>;
  readonly resumeSandbox: (sandboxId: string) => Effect.Effect<CloudSandbox, SandboxProviderError>;
  readonly deleteSandbox: (sandboxId: string) => Effect.Effect<void, SandboxProviderError>;
  /** Resolve how T3 should connect to a running sandbox. */
  readonly resolveConnectionTarget: (
    sandboxId: string,
  ) => Effect.Effect<SandboxConnectionTarget, SandboxProviderError>;
}

/**
 * Secure credential store for sandbox provider API keys. Implementations must
 * use T3 Code's secure credential facilities (ServerSecretStore) or the native
 * OS keychain. Keys are referenced by `credentialKey`, never by value.
 */
export class SandboxProviderCredentialStore extends Context.Service<
  SandboxProviderCredentialStore,
  {
    readonly get: (
      credentialKey: string,
    ) => Effect.Effect<string, SandboxProviderError>;
    readonly set: (
      credentialKey: string,
      secret: string,
    ) => Effect.Effect<void, SandboxProviderError>;
    readonly remove: (credentialKey: string) => Effect.Effect<void, SandboxProviderError>;
  }
>()("t3/executionEnvironment/cloud/SandboxProviderCredentialStore") {}

/**
 * Registry of sandbox provider adapters. Adding a provider = registering an
 * adapter; the rest of T3 Code resolves providers by kind and never branches.
 */
export class SandboxProviderRegistry extends Context.Service<
  SandboxProviderRegistry,
  {
    readonly register: (adapter: SandboxProviderAdapter) => Effect.Effect<void>;
    readonly get: (
      kind: SandboxProviderKind,
    ) => Effect.Effect<SandboxProviderAdapter, SandboxProviderError>;
    readonly list: Effect.Effect<ReadonlyArray<SandboxProviderKind>>;
  }
>()("t3/executionEnvironment/cloud/SandboxProviderRegistry") {}

export const makeSandboxProviderRegistry = Effect.gen(function* () {
  const adapters = new Map<SandboxProviderKind, SandboxProviderAdapter>();
  return SandboxProviderRegistry.of({
    register: (adapter) => Effect.sync(() => adapters.set(adapter.kind, adapter)),
    get: (kind) =>
      Effect.gen(function* () {
        const adapter = adapters.get(kind);
        if (adapter === undefined) {
          return yield* new SandboxProviderError({
            providerKind: kind,
            operation: "get",
            detail: "No sandbox provider adapter is registered for this kind.",
          });
        }
        return adapter;
      }),
    list: Effect.sync(() => [...adapters.keys()]),
  });
});

export const sandboxProviderRegistryLayer = Layer.effect(
  SandboxProviderRegistry,
  makeSandboxProviderRegistry,
);

