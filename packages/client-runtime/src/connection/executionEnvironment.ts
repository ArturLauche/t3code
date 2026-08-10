import type {
  CloudSandboxLifecycleCapabilities,
  ExecutionEnvironmentCategory,
  ExecutionEnvironmentOperationCapabilities,
} from "@t3tools/contracts";

import type { ConnectionTarget } from "./model.ts";

/**
 * Classifies every existing connection target without changing its transport.
 * Local, SSH, and sandbox targets still prepare through their native brokers;
 * consumers that only care where execution happens use this common view.
 */
export function executionEnvironmentCategory(
  target: ConnectionTarget,
): ExecutionEnvironmentCategory | null {
  switch (target._tag) {
    case "SshConnectionTarget":
      return "ssh-remote";
    case "CloudSandboxConnectionTarget":
      return "cloud-sandbox";
    case "PrimaryConnectionTarget":
      return "local";
    case "BearerConnectionTarget":
    case "RelayConnectionTarget":
      // Legacy paired/relay registrations do not encode their execution
      // location. Preserve them without presenting a guessed category.
      return null;
  }
}

export function executionEnvironmentCapabilities(
  target: ConnectionTarget,
  cloudLifecycle?: CloudSandboxLifecycleCapabilities,
): ExecutionEnvironmentOperationCapabilities {
  const common = {
    connect: true,
    status: true,
    bootstrap: true,
    commandExecution: true,
    filesystem: true,
    gitCredentials: true,
    endpointDiscovery: true,
    reconnect: true,
  } as const;

  switch (target._tag) {
    case "CloudSandboxConnectionTarget":
      return {
        ...common,
        create: true,
        shutdown: cloudLifecycle?.stop ?? false,
        pause: cloudLifecycle?.pause ?? false,
        resume: cloudLifecycle?.resume ?? false,
        delete: cloudLifecycle?.delete ?? false,
      };
    case "SshConnectionTarget":
      return {
        ...common,
        create: false,
        shutdown: false,
        pause: false,
        resume: false,
        delete: false,
      };
    case "PrimaryConnectionTarget":
    case "BearerConnectionTarget":
    case "RelayConnectionTarget":
      return {
        ...common,
        create: false,
        shutdown: false,
        pause: false,
        resume: false,
        delete: false,
      };
  }
}
