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
  private starting: Promise<GitHubDeviceFlowAuthorization> | null = null;
  private lastError: unknown | null = null;
  private readonly options: GitHubDeviceFlowOptions;

  constructor(options: GitHubDeviceFlowOptions) {
    this.options = options;
  }

  start(): Promise<GitHubDeviceFlowAuthorization> {
    if (this.pending?.state.status === "pending") {
      return Promise.resolve(this.pending.authorization);
    }
    if (this.starting !== null) {
      return this.starting;
    }

    this.pending = null;
    this.lastError = null;
    let verificationReceived = false;
    const verification = Promise.withResolvers<Verification>();

    let authentication: Promise<OAuthAppAuthentication>;
    const starting = verification.promise.then((value) => {
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
    });
    this.starting = starting;

    try {
      const auth = createOAuthDeviceAuth({
        clientId: this.options.clientId,
        clientType: "oauth-app",
        scopes: [...(this.options.scopes ?? ["repo", "read:org", "workflow"])],
        onVerification: (value) => {
          verificationReceived = true;
          verification.resolve(value);
        },
      });
      authentication = auth({ type: "oauth" });
      void authentication.then(
        () => {
          if (!verificationReceived) {
            verification.reject(
              new Error("GitHub device authorization completed without verification."),
            );
          }
        },
        (error: unknown) => verification.reject(error),
      );
    } catch (error) {
      authentication = Promise.reject(error);
      void authentication.catch(() => undefined);
      verification.reject(error);
    }

    void starting.then(
      () => {
        if (this.starting === starting) this.starting = null;
      },
      (error: unknown) => {
        if (this.starting === starting) this.starting = null;
        this.lastError = error;
      },
    );
    return starting;
  }

  poll(): GitHubDeviceFlowPollResult {
    return (
      this.pending?.state ??
      (this.lastError === null
        ? { status: "error", error: new Error("No device flow is active.") }
        : { status: "error", error: this.lastError })
    );
  }

  clear(): void {
    this.pending = null;
    this.starting = null;
    this.lastError = null;
  }
}
