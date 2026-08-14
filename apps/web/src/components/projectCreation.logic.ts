import type { ConnectionTargetKind } from "@t3tools/client-runtime/connection";
import type {
  CloudSandboxCreateInput,
  CloudSandboxProviderConnection,
  GitHubRepositorySummary,
  SourceControlRepositoryInfo,
} from "@t3tools/contracts";

export type ExecutionEnvironmentPickerCategory =
  | "Local"
  | "SSH Remote"
  | "Cloud Sandbox"
  | "Remote";

function assertNever(value: never): never {
  throw new Error(`Unhandled connection target kind: ${String(value)}`);
}

export function executionEnvironmentPickerCategory(input: {
  readonly targetTag: ConnectionTargetKind;
  readonly desktopLocal: boolean;
}): ExecutionEnvironmentPickerCategory {
  switch (input.targetTag) {
    case "PrimaryConnectionTarget":
      return "Local";
    case "BearerConnectionTarget":
      return input.desktopLocal ? "Local" : "Remote";
    case "RelayConnectionTarget":
      return "Remote";
    case "SshConnectionTarget":
      return "SSH Remote";
    case "CloudSandboxConnectionTarget":
      return "Cloud Sandbox";
    default:
      return assertNever(input.targetTag);
  }
}

export function githubRepositoryCloneSelection(
  repository: Pick<GitHubRepositorySummary, "nameWithOwner" | "url" | "sshUrl" | "cloneUrl">,
): { readonly repository: SourceControlRepositoryInfo; readonly remoteUrl: string } {
  return {
    repository: {
      provider: "github",
      nameWithOwner: repository.nameWithOwner,
      url: repository.url,
      sshUrl: repository.sshUrl,
    },
    // Never add a credential to this URL. The target T3 server injects it for
    // the individual Git process through GIT_ASKPASS.
    remoteUrl: repository.cloneUrl,
  };
}

export function quickEphemeralSandboxInput(
  connection: CloudSandboxProviderConnection,
  name: string,
): CloudSandboxCreateInput {
  const common = {
    providerConnectionId: connection.id,
    provider: connection.provider,
    ephemeral: true,
    name,
  } as const;
  switch (connection.provider) {
    case "daytona":
      // Daytona ephemeral sandboxes delete when stopped; TTL adds the same
      // 60-minute hard ceiling used by the other task-sandbox providers.
      return { ...common, provider: "daytona", ttlMinutes: 60 };
    case "e2b":
      return {
        ...common,
        provider: "e2b",
        timeoutMinutes: 60,
        timeoutAction: "delete",
        autoResume: false,
      };
    case "novita":
      return {
        ...common,
        provider: "novita",
        timeoutMinutes: 60,
        timeoutAction: "delete",
        autoResume: false,
      };
  }
}
