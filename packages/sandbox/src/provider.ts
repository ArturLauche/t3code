import type {
  CloudSandboxCreateInput,
  CloudSandboxLifecycleCapabilities,
  CloudSandboxProviderKind,
  CloudSandboxRecord,
} from "@t3tools/contracts";

export interface SandboxProviderCredential {
  readonly apiKey: string;
  readonly apiUrl?: string;
}

export interface SandboxCommandInput {
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly background?: boolean;
  readonly timeoutMs?: number;
}

export interface SandboxCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly processId?: number;
}

export interface SandboxSshAccess {
  readonly token: string;
  readonly hostname: string;
  readonly username: string;
  readonly port: number;
  readonly expiresAt: string;
  readonly revoke: () => Promise<void>;
}

export interface SandboxProviderAdapter {
  readonly kind: CloudSandboxProviderKind;
  readonly lifecycle: CloudSandboxLifecycleCapabilities;
  readonly validate: () => Promise<void>;
  readonly list: () => Promise<readonly CloudSandboxRecord[]>;
  readonly get: (sandboxId: string) => Promise<CloudSandboxRecord>;
  readonly create: (input: CloudSandboxCreateInput) => Promise<CloudSandboxRecord>;
  readonly connect: (sandboxId: string) => Promise<CloudSandboxRecord>;
  readonly start?: (sandboxId: string) => Promise<CloudSandboxRecord>;
  readonly stop?: (sandboxId: string) => Promise<CloudSandboxRecord>;
  readonly pause?: (sandboxId: string) => Promise<CloudSandboxRecord>;
  readonly resume?: (sandboxId: string) => Promise<CloudSandboxRecord>;
  readonly delete: (sandboxId: string) => Promise<void>;
  readonly runCommand?: (
    sandboxId: string,
    input: SandboxCommandInput,
  ) => Promise<SandboxCommandResult>;
  readonly getEndpoint?: (sandboxId: string, port: number) => Promise<string>;
  readonly createSshAccess?: (
    sandboxId: string,
    expiresInMinutes?: number,
  ) => Promise<SandboxSshAccess>;
}

export class SandboxProviderError extends Error {
  readonly provider: CloudSandboxProviderKind;
  readonly operation: string;
  override readonly cause?: unknown;

  constructor(input: {
    readonly provider: CloudSandboxProviderKind;
    readonly operation: string;
    readonly detail: string;
    readonly cause?: unknown;
  }) {
    super(`${input.provider} ${input.operation} failed: ${input.detail}`);
    this.name = "SandboxProviderError";
    this.provider = input.provider;
    this.operation = input.operation;
    this.cause = input.cause;
  }
}

export function providerError(
  provider: CloudSandboxProviderKind,
  operation: string,
  cause: unknown,
): SandboxProviderError {
  const detail = cause instanceof Error && cause.message.trim() ? cause.message : "Request failed.";
  return new SandboxProviderError({ provider, operation, detail, cause });
}
