import type { CloudRuntimeId, CloudSandboxSummary } from "@t3tools/contracts";

/**
 * Whether a vendor sandbox belongs to this environment and runtime, proven only
 * by server-stamped metadata because vendor accounts can be shared.
 */
export const isManagedSandbox = (
  sandbox: CloudSandboxSummary,
  runtimeId: CloudRuntimeId,
  environmentId: string,
): boolean =>
  sandbox.metadata?.t3ManagedExecution === "true" &&
  sandbox.metadata?.t3RuntimeId === runtimeId &&
  sandbox.metadata?.t3EnvironmentId === environmentId;
