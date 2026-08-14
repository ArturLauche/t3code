import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** The three places where a T3 server can own projects, terminals, Git, and agents. */
export const ExecutionEnvironmentCategory = Schema.Literals([
  "local",
  "ssh-remote",
  "cloud-sandbox",
]);
export type ExecutionEnvironmentCategory = typeof ExecutionEnvironmentCategory.Type;

/**
 * Provider-independent operations advertised by an execution environment.
 * Unsupported lifecycle buttons are hidden rather than emulated.
 */
export const ExecutionEnvironmentOperationCapabilities = Schema.Struct({
  create: Schema.Boolean,
  connect: Schema.Boolean,
  start: Schema.Boolean,
  status: Schema.Boolean,
  bootstrap: Schema.Boolean,
  commandExecution: Schema.Boolean,
  filesystem: Schema.Boolean,
  gitCredentials: Schema.Boolean,
  endpointDiscovery: Schema.Boolean,
  reconnect: Schema.Boolean,
  shutdown: Schema.Boolean,
  pause: Schema.Boolean,
  resume: Schema.Boolean,
  delete: Schema.Boolean,
});
export type ExecutionEnvironmentOperationCapabilities =
  typeof ExecutionEnvironmentOperationCapabilities.Type;

export const CloudSandboxProviderKind = Schema.Literals(["daytona", "e2b", "novita"]);
export type CloudSandboxProviderKind = typeof CloudSandboxProviderKind.Type;

export const CloudSandboxProviderConnectionId = TrimmedNonEmptyString.pipe(
  Schema.brand("CloudSandboxProviderConnectionId"),
);
export type CloudSandboxProviderConnectionId = typeof CloudSandboxProviderConnectionId.Type;

export const CloudSandboxStatus = Schema.Literals([
  "creating",
  "starting",
  "running",
  "stopping",
  "stopped",
  "pausing",
  "paused",
  "deleting",
  "deleted",
  "error",
  "unknown",
]);
export type CloudSandboxStatus = typeof CloudSandboxStatus.Type;

export const CloudSandboxLifecycleAction = Schema.Literals([
  "connect",
  "start",
  "stop",
  "pause",
  "resume",
  "delete",
]);
export type CloudSandboxLifecycleAction = typeof CloudSandboxLifecycleAction.Type;

export const CloudSandboxResources = Schema.Struct({
  cpu: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThan(0))),
  memoryMiB: Schema.optionalKey(PositiveInt),
  diskGiB: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThan(0))),
});
export type CloudSandboxResources = typeof CloudSandboxResources.Type;

export const CloudSandboxLifecycleCapabilities = Schema.Struct({
  connect: Schema.Boolean,
  start: Schema.Boolean,
  stop: Schema.Boolean,
  pause: Schema.Boolean,
  resume: Schema.Boolean,
  delete: Schema.Boolean,
});
export type CloudSandboxLifecycleCapabilities = typeof CloudSandboxLifecycleCapabilities.Type;

export const CloudSandboxAutomaticShutdown = Schema.Struct({
  timeoutMinutes: Schema.optionalKey(PositiveInt),
  action: Schema.optionalKey(Schema.Literals(["stop", "pause", "delete"])),
  autoResume: Schema.optionalKey(Schema.Boolean),
});
export type CloudSandboxAutomaticShutdown = typeof CloudSandboxAutomaticShutdown.Type;

export const CloudSandboxProviderConnection = Schema.Struct({
  id: CloudSandboxProviderConnectionId,
  provider: CloudSandboxProviderKind,
  label: TrimmedNonEmptyString,
  apiUrl: Schema.NullOr(TrimmedNonEmptyString),
  credentialConfigured: Schema.Boolean,
  createdAt: Schema.String,
  lastValidatedAt: Schema.NullOr(Schema.String),
});
export type CloudSandboxProviderConnection = typeof CloudSandboxProviderConnection.Type;

export const CloudSandboxRecord = Schema.Struct({
  providerConnectionId: CloudSandboxProviderConnectionId,
  provider: CloudSandboxProviderKind,
  sandboxId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  status: CloudSandboxStatus,
  region: Schema.optionalKey(TrimmedNonEmptyString),
  template: Schema.optionalKey(TrimmedNonEmptyString),
  resources: Schema.optionalKey(CloudSandboxResources),
  automaticShutdown: Schema.optionalKey(CloudSandboxAutomaticShutdown),
  persistent: Schema.Boolean,
  associatedProject: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  lifecycle: CloudSandboxLifecycleCapabilities,
});
export type CloudSandboxRecord = typeof CloudSandboxRecord.Type;

const CloudSandboxCreateBase = {
  providerConnectionId: CloudSandboxProviderConnectionId,
  name: Schema.optionalKey(TrimmedNonEmptyString),
  ephemeral: Schema.optionalKey(Schema.Boolean),
  associatedProject: Schema.optionalKey(TrimmedNonEmptyString),
} as const;

export const DaytonaSandboxCreateInput = Schema.Struct({
  ...CloudSandboxCreateBase,
  provider: Schema.Literal("daytona"),
  image: Schema.optionalKey(TrimmedNonEmptyString),
  snapshot: Schema.optionalKey(TrimmedNonEmptyString),
  region: Schema.optionalKey(TrimmedNonEmptyString),
  cpu: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThan(0))),
  memoryGiB: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThan(0))),
  diskGiB: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThan(0))),
  autoStopMinutes: Schema.optionalKey(NonNegativeInt),
  autoPauseMinutes: Schema.optionalKey(NonNegativeInt),
  autoDeleteMinutes: Schema.optionalKey(NonNegativeInt),
  ttlMinutes: Schema.optionalKey(NonNegativeInt),
});
export type DaytonaSandboxCreateInput = typeof DaytonaSandboxCreateInput.Type;

export const E2bSandboxCreateInput = Schema.Struct({
  ...CloudSandboxCreateBase,
  provider: Schema.Literal("e2b"),
  template: Schema.optionalKey(TrimmedNonEmptyString),
  timeoutMinutes: Schema.optionalKey(PositiveInt),
  timeoutAction: Schema.optionalKey(Schema.Literals(["pause", "delete"])),
  autoResume: Schema.optionalKey(Schema.Boolean),
});
export type E2bSandboxCreateInput = typeof E2bSandboxCreateInput.Type;

export const NovitaSandboxCreateInput = Schema.Struct({
  ...CloudSandboxCreateBase,
  provider: Schema.Literal("novita"),
  template: Schema.optionalKey(TrimmedNonEmptyString),
  timeoutMinutes: Schema.optionalKey(PositiveInt),
  timeoutAction: Schema.optionalKey(Schema.Literals(["pause", "delete"])),
  autoResume: Schema.optionalKey(Schema.Boolean),
  nodeId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type NovitaSandboxCreateInput = typeof NovitaSandboxCreateInput.Type;

export const CloudSandboxCreateInput = Schema.Union([
  DaytonaSandboxCreateInput,
  E2bSandboxCreateInput,
  NovitaSandboxCreateInput,
]);
export type CloudSandboxCreateInput = typeof CloudSandboxCreateInput.Type;

export const CloudSandboxProviderConnectionInput = Schema.Struct({
  provider: CloudSandboxProviderKind,
  label: TrimmedNonEmptyString,
  apiKey: TrimmedNonEmptyString,
  apiUrl: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CloudSandboxProviderConnectionInput = typeof CloudSandboxProviderConnectionInput.Type;

export const CloudSandboxProviderConnectionIdInput = Schema.Struct({
  id: CloudSandboxProviderConnectionId,
});
export type CloudSandboxProviderConnectionIdInput =
  typeof CloudSandboxProviderConnectionIdInput.Type;

export const CloudSandboxLifecycleInput = Schema.Struct({
  providerConnectionId: CloudSandboxProviderConnectionId,
  sandboxId: TrimmedNonEmptyString,
  action: CloudSandboxLifecycleAction,
});
export type CloudSandboxLifecycleInput = typeof CloudSandboxLifecycleInput.Type;

export const CloudSandboxAssociationInput = Schema.Struct({
  providerConnectionId: CloudSandboxProviderConnectionId,
  sandboxId: TrimmedNonEmptyString,
  project: Schema.NullOr(TrimmedNonEmptyString),
});
export type CloudSandboxAssociationInput = typeof CloudSandboxAssociationInput.Type;

export const DesktopCloudSandboxTargetSchema = Schema.Struct({
  providerConnectionId: CloudSandboxProviderConnectionId,
  provider: CloudSandboxProviderKind,
  sandboxId: TrimmedNonEmptyString,
});
export type DesktopCloudSandboxTarget = typeof DesktopCloudSandboxTargetSchema.Type;

export const CloudSandboxEnsureInput = Schema.Struct({
  target: DesktopCloudSandboxTargetSchema,
  issuePairingToken: Schema.optionalKey(Schema.Boolean),
});
export type CloudSandboxEnsureInput = typeof CloudSandboxEnsureInput.Type;

export const DesktopCloudSandboxBootstrapSchema = Schema.Struct({
  target: DesktopCloudSandboxTargetSchema,
  sandbox: CloudSandboxRecord,
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  httpBaseUrl: TrimmedNonEmptyString,
  wsBaseUrl: TrimmedNonEmptyString,
  bearerToken: Schema.NullOr(TrimmedNonEmptyString),
});
export type DesktopCloudSandboxBootstrap = typeof DesktopCloudSandboxBootstrapSchema.Type;

export class ExecutionEnvironmentOperationError extends Schema.TaggedErrorClass<ExecutionEnvironmentOperationError>()(
  "ExecutionEnvironmentOperationError",
  {
    category: ExecutionEnvironmentCategory,
    operation: Schema.String,
    provider: Schema.optionalKey(CloudSandboxProviderKind),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `${this.category} environment ${this.operation} failed: ${this.detail}`;
  }
}
