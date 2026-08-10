import { createOAuthDeviceAuth, type OAuthAppAuthentication } from "@octokit/auth-oauth-device";

interface Verification {
  readonly user_code: string;
  readonly verification_uri: string;
  readonly expires_in: number;
  readonly interval: number;
}

export interface GitHubDeviceFlowOptions {
  readonly clientId: string;
  readonly scopes?: readonly string[];
}

export interface GitHubDeviceFlowAuthorization {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
}

export type GitHubDeviceFlowPollResult =
  | { readonly status: "pending" }
  | { readonly status: "complete"; readonly authentication: OAuthAppAuthentication }
  | { readonly status: "error"; readonly error: unknown };

interface PendingDeviceFlow {
  readonly authorization: GitHubDeviceFlowAuthorization;
  result: Promise<void>;
  state: GitHubDeviceFlowPollResult;
}

export class GitHubDeviceFlow {
  private pending: PendingDeviceFlow | null = null;
  private readonly options: GitHubDeviceFlowOptions;

  constructor(options: GitHubDeviceFlowOptions) {
    this.options = options;
  }

  async start(): Promise<GitHubDeviceFlowAuthorization> {
    if (this.pending?.state.status === "pending") {
      return this.pending.authorization;
    }

    let resolveVerification: ((verification: Verification) => void) | null = null;
    const verification = new Promise<Verification>((resolve) => {
      resolveVerification = resolve;
    });
    const auth = createOAuthDeviceAuth({
      clientId: this.options.clientId,
      clientType: "oauth-app",
      scopes: [...(this.options.scopes ?? ["repo", "read:org", "workflow"])],
      onVerification: (value) => {
        resolveVerification?.(value);
      },
    });

    const authentication = auth({ type: "oauth" });
    const value = await verification;
    const authorization = {
      userCode: value.user_code,
      verificationUri: value.verification_uri,
      expiresInSeconds: value.expires_in,
      intervalSeconds: value.interval,
    } satisfies GitHubDeviceFlowAuthorization;
    const pending: PendingDeviceFlow = {
      authorization,
      state: { status: "pending" },
      result: Promise.resolve(),
    };
    pending.result = authentication.then(
      (result) => {
        pending.state = { status: "complete", authentication: result };
      },
      (error: unknown) => {
        pending.state = { status: "error", error };
      },
    );
    this.pending = pending;
    return authorization;
  }

  poll(): GitHubDeviceFlowPollResult {
    return (
      this.pending?.state ?? { status: "error", error: new Error("No device flow is active.") }
    );
  }

  clear(): void {
    this.pending = null;
  }
}
