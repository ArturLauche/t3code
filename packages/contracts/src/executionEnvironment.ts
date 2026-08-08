import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { EnvironmentId, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * First-class execution environment categories. T3 Code agents can execute in
 * one of three categories, all surfaced through the common
 * {@link ExecutionEnvironmentContract}:
 *
 * - `local`      — the machine running the T3 server (the original model).
 * - `ssh-remote` — a remote host reached over SSH; the remote host owns files,
 *                  git state, terminals and agent sessions. T3 starts or reuses
 *                  a T3 server on the target host.
 * - `cloud`      — a managed cloud sandbox (Daytona, E2B, Novita, ...) provisioned
 *                  on demand and connected into T3 as a saved environment.
 *
 * The category is metadata: the transport and lifecycle specifics live behind a
 * provider adapter so the rest of T3 Code treats every environment uniformly.
 */
export const ExecutionEnvironmentCategory = Schema.Literals([
  "local",
  "ssh-remote",
  "cloud",
]);
export type ExecutionEnvironmentCategory = typeof ExecutionEnvironmentCategory.Type;

/**
 * Lifecycle states an execution environment can occupy. Not every category or
 * provider supports every state — see {@link SandboxLifecycleCapabilities}. The
 * states intentionally mirror the cloud-sandbox vocabulary so the same state
 * machine describes a local server (which is effectively always "running" while
 * the desktop is up) and an on-demand cloud sandbox.
 */
export const ExecutionEnvironmentLifecycleState = Schema.Literals([
  "creating",
  "starting",
  "running",
  "paused",
  "stopped",
  "deleting",
  "deleted",
  "error",
]);
export type ExecutionEnvironmentLifecycleState =
  typeof ExecutionEnvironmentLifecycleState.Type;

/** Capabilities a sandbox provider actually supports, per its real SDK/API. */
export const SandboxLifecycleCapabilities = Schema.Struct({
  create: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  reconnect: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  status: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  start: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  stop: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  pause: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  resume: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  delete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Provider exposes configured CPU/RAM/disk so the UI can show cost info. */
  resourceInfo: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Provider exposes a region. */
  region: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Provider exposes automatic-stop / timeout settings. */
  autoStop: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type SandboxLifecycleCapabilities = typeof SandboxLifecycleCapabilities.Type;

/** Provider kinds shipped with T3 Code. Open set via string for future providers. */
export const SandboxProviderKind = Schema.Literals(["daytona", "e2b", "novita"]);
export type SandboxProviderKind = typeof SandboxProviderKind.Type;

/** A configured sandbox provider connection (API key held in the secure store). */
export const SandboxProviderConfig = Schema.Struct({
  kind: SandboxProviderKind,
  label: TrimmedNonEmptyString,
  /** Host/region hint for providers that support self-hosted endpoints. */
  apiUrl: Schema.optionalKey(TrimmedNonEmptyString),
  createdAt: Schema.String,
  lastValidatedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type SandboxProviderConfig = typeof SandboxProviderConfig.Type;

/** Provider-specific options exposed only where the provider supports them. */
export const SandboxProvisionOptions = Schema.Struct({
  template: Schema.optionalKey(TrimmedNonEmptyString),
  image: Schema.optionalKey(TrimmedNonEmptyString),
  region: Schema.optionalKey(TrimmedNonEmptyString),
  cpu: Schema.optionalKey(PositiveInt),
  memoryMB: Schema.optionalKey(PositiveInt),
  diskGB: Schema.optionalKey(PositiveInt),
  /** Idle timeout / auto-stop in seconds, where supported. */
  autoStopSeconds: Schema.optionalKey(PositiveInt),
  /** Persist the sandbox across restarts (snapshots), where supported. */
  persistent: Schema.optionalKey(Schema.Boolean),
});
export type SandboxProvisionOptions = typeof SandboxProvisionOptions.Type;

/** Resource info reported by a provider, when {@link SandboxLifecycleCapabilities.resourceInfo}. */
export const SandboxResourceInfo = Schema.Struct({
  cpu: Schema.optionalKey(PositiveInt),
  memoryMB: Schema.optionalKey(PositiveInt),
  diskGB: Schema.optionalKey(PositiveInt),
});
export type SandboxResourceInfo = typeof SandboxResourceInfo.Type;

/**
 * A cloud sandbox instance. The `sandboxId` is provider-native; `environmentId`
 * is the T3 environment id minted once the sandbox is connected as a saved
 * environment. Either may be absent during creation before a descriptor is
 * resolved.
 */
export const CloudSandbox = Schema.Struct({
  sandboxId: Schema.optionalKey(TrimmedNonEmptyString),
  providerKind: SandboxProviderKind,
  label: TrimmedNonEmptyString,
  state: ExecutionEnvironmentLifecycleState,
  region: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  resources: Schema.optionalKey(Schema.NullOr(SandboxResourceInfo)),
  autoStopSeconds: Schema.optionalKey(Schema.NullOr(PositiveInt)),
  persistent: Schema.optionalKey(Schema.Boolean),
  /** Associated T3 project, if the sandbox was created for one. */
  projectId: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  createdAt: Schema.String,
  /** The saved T3 environment this sandbox resolves into once connected. */
  environmentId: Schema.optionalKey(Schema.NullOr(EnvironmentId)),
});
export type CloudSandbox = typeof CloudSandbox.Type;

/** Result of validating a sandbox provider connection. */
export const SandboxProviderValidationResult = Schema.Struct({
  ok: Schema.Boolean,
  account: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  detail: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
});
export type SandboxProviderValidationResult = typeof SandboxProviderValidationResult.Type;

/**
 * The common contract every execution environment presents to T3 Code,
 * regardless of category. This is the abstraction the orchestration layer,
 * source control, and UI program against. Local and SSH-remote are existing
 * implementations; cloud sandboxes adapt their providers to this contract.
 */
export const ExecutionEnvironmentContract = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  category: ExecutionEnvironmentCategory,
  /** Provider kind for cloud environments; absent for local/ssh-remote. */
  providerKind: Schema.optionalKey(SandboxProviderKind),
  state: ExecutionEnvironmentLifecycleState,
  /** T3 connection target once the environment is reachable. */
  httpBaseUrl: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  wsBaseUrl: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
});
export type ExecutionEnvironmentContract = typeof ExecutionEnvironmentContract.Type;
