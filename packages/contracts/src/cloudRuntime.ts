import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const CloudDomain = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2_048),
  Schema.isPattern(/^[a-zA-Z0-9.-]+(?::[0-9]{1,5})?$/u),
);
const CloudApiUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2_048),
  Schema.isPattern(/^https:\/\/[^\s/?#@]+(?:\/[^\s?#]*)?$/u),
);
const CloudRuntimeIdSchema = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^(?!local$)[a-zA-Z][a-zA-Z0-9_-]*$/u),
);

export const CloudRuntimeId = CloudRuntimeIdSchema.pipe(Schema.brand("CloudRuntimeId"));
export type CloudRuntimeId = typeof CloudRuntimeId.Type;

export const CloudRuntimeKind = Schema.Literals(["daytona", "e2b", "novita"]);
export type CloudRuntimeKind = typeof CloudRuntimeKind.Type;

export const CloudRuntimeConfig = Schema.Struct({
  kind: CloudRuntimeKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  region: Schema.optional(TrimmedNonEmptyString),
  template: Schema.optional(TrimmedNonEmptyString),
  domain: Schema.optional(CloudDomain),
  apiUrl: Schema.optional(CloudApiUrl),
  autoPauseMinutes: Schema.optional(NonNegativeInt),
  setupCommands: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(4_000))).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type CloudRuntimeConfig = typeof CloudRuntimeConfig.Type;

export const CloudRuntimeConfigMap = Schema.Record(CloudRuntimeId, CloudRuntimeConfig);
export type CloudRuntimeConfigMap = typeof CloudRuntimeConfigMap.Type;

/** A provider instance's optional cloud execution destination. */
export const ProviderExecutionTarget = Schema.Struct({
  runtimeId: CloudRuntimeId,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type ProviderExecutionTarget = typeof ProviderExecutionTarget.Type;

/** Stable, non-secret handle persisted under a provider session's runtime payload. */
export const CloudExecutionHandle = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  runtimeId: CloudRuntimeId,
  kind: CloudRuntimeKind,
  sandboxId: TrimmedNonEmptyString,
  remoteCwd: TrimmedNonEmptyString,
  /** Isolated writable home created inside the sandbox for provider state. */
  remoteHome: Schema.optional(TrimmedNonEmptyString),
  owned: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type CloudExecutionHandle = typeof CloudExecutionHandle.Type;

export const CloudRuntimeHealthStatus = Schema.Literals([
  "ready",
  "unconfigured",
  "disabled",
  "error",
  "checking",
]);
export type CloudRuntimeHealthStatus = typeof CloudRuntimeHealthStatus.Type;

export const CloudRuntimeHealth = Schema.Struct({
  status: CloudRuntimeHealthStatus,
  message: Schema.NullOr(TrimmedNonEmptyString),
  checkedAt: IsoDateTime,
});
export type CloudRuntimeHealth = typeof CloudRuntimeHealth.Type;

export const CloudSandboxState = Schema.Literals([
  "creating",
  "running",
  "paused",
  "stopped",
  "error",
  "unknown",
]);
export type CloudSandboxState = typeof CloudSandboxState.Type;

export const CloudSandboxSummary = Schema.Struct({
  runtimeId: CloudRuntimeId,
  kind: CloudRuntimeKind,
  sandboxId: TrimmedNonEmptyString,
  name: Schema.NullOr(TrimmedNonEmptyString),
  state: CloudSandboxState,
  createdAt: Schema.NullOr(IsoDateTime),
  remoteCwd: Schema.optional(TrimmedNonEmptyString),
  metadata: Schema.optional(Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString)),
});
export type CloudSandboxSummary = typeof CloudSandboxSummary.Type;

export const CloudRuntimeInstance = Schema.Struct({
  id: CloudRuntimeId,
  config: CloudRuntimeConfig,
  hasCredential: Schema.Boolean,
  health: CloudRuntimeHealth,
  sandboxes: Schema.Array(CloudSandboxSummary),
});
export type CloudRuntimeInstance = typeof CloudRuntimeInstance.Type;

export const CloudRuntimeListResult = Schema.Struct({
  runtimes: Schema.Array(CloudRuntimeInstance),
});
export type CloudRuntimeListResult = typeof CloudRuntimeListResult.Type;

export const CloudRuntimeCredentialInput = Schema.Struct({
  runtimeId: CloudRuntimeId,
  apiKey: TrimmedNonEmptyString.check(Schema.isMaxLength(16_384)),
});
export type CloudRuntimeCredentialInput = typeof CloudRuntimeCredentialInput.Type;

export const CloudRuntimeTestInput = Schema.Struct({
  runtimeId: CloudRuntimeId,
});
export type CloudRuntimeTestInput = typeof CloudRuntimeTestInput.Type;

export const CloudRuntimeSandboxCreateInput = Schema.Struct({
  runtimeId: CloudRuntimeId,
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  metadata: Schema.optional(Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString)),
});
export type CloudRuntimeSandboxCreateInput = typeof CloudRuntimeSandboxCreateInput.Type;

export const CloudRuntimeSandboxListInput = Schema.Struct({
  runtimeId: CloudRuntimeId,
});
export type CloudRuntimeSandboxListInput = typeof CloudRuntimeSandboxListInput.Type;

export const CloudRuntimeSandboxListResult = Schema.Struct({
  sandboxes: Schema.Array(CloudSandboxSummary),
});
export type CloudRuntimeSandboxListResult = typeof CloudRuntimeSandboxListResult.Type;

export const CloudRuntimeSandboxRef = Schema.Struct({
  runtimeId: CloudRuntimeId,
  sandboxId: TrimmedNonEmptyString,
});
export type CloudRuntimeSandboxRef = typeof CloudRuntimeSandboxRef.Type;

export const CloudRuntimeSandboxAction = Schema.Literals(["pause", "resume", "stop", "delete"]);
export type CloudRuntimeSandboxAction = typeof CloudRuntimeSandboxAction.Type;

export const CloudRuntimeSandboxActionInput = Schema.Struct({
  ...CloudRuntimeSandboxRef.fields,
  action: CloudRuntimeSandboxAction,
});
export type CloudRuntimeSandboxActionInput = typeof CloudRuntimeSandboxActionInput.Type;

export const CloudRuntimeExecuteInput = Schema.Struct({
  ...CloudRuntimeSandboxRef.fields,
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(32_000)),
  cwd: Schema.optional(TrimmedNonEmptyString),
  timeoutSeconds: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(86_400),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(300))),
});
export type CloudRuntimeExecuteInput = typeof CloudRuntimeExecuteInput.Type;

export const CloudRuntimeExecuteResult = Schema.Struct({
  exitCode: Schema.Int,
  stdout: Schema.String.check(Schema.isMaxLength(1_000_000)),
  stderr: Schema.String.check(Schema.isMaxLength(1_000_000)),
});
export type CloudRuntimeExecuteResult = typeof CloudRuntimeExecuteResult.Type;

export const CloudRuntimeErrorReason = Schema.Literals([
  "runtime_not_configured",
  "runtime_disabled",
  "credential_missing",
  "invalid_credential",
  "provider_not_found",
  "sandbox_not_found",
  "operation_failed",
  "unsupported",
]);
export type CloudRuntimeErrorReason = typeof CloudRuntimeErrorReason.Type;

export class CloudRuntimeError extends Schema.TaggedError<CloudRuntimeError>()(
  "CloudRuntimeError",
  {
    runtimeId: Schema.optional(CloudRuntimeId),
    operation: TrimmedNonEmptyString,
    reason: CloudRuntimeErrorReason,
    message: TrimmedNonEmptyString,
  },
) {}

/** Best-effort classification used to keep vendor failures off the wire verbatim. */
export const cloudRuntimeErrorMessage = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.trim()) {
    return cause.message.trim().slice(0, 1_000);
  }
  return "The cloud runtime operation failed.";
};
