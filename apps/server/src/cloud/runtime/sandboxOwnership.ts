import type { CloudRuntimeId, CloudSandboxSummary } from "@t3tools/contracts";

/**
 * Whether a vendor sandbox is one this environment created for this runtime.
 *
 * Ownership is proven by metadata the server stamped on create and read back
 * from the vendor, never by anything a client sent: a client can ask for a
 * sandbox id, but the vendor account can legitimately be shared between T3
 * environments, and the environment id is what separates them.
 */
export const isManagedSandbox = (
  sandbox: CloudSandboxSummary,
  runtimeId: CloudRuntimeId,
  environmentId: string,
): boolean =>
  sandbox.metadata?.t3ManagedExecution === "true" &&
  sandbox.metadata?.t3RuntimeId === runtimeId &&
  sandbox.metadata?.t3EnvironmentId === environmentId;
