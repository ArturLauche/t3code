import type {
  DesktopGitHubCredentialSyncInput,
  GitHubConnectionStatus,
  GitHubDeviceAuthorization,
  GitHubPersonalAccessTokenInput,
  GitHubRepositoryListInput,
  GitHubRepositoryListResult,
} from "@t3tools/contracts";
import { GitHubDeviceFlow, makeGitHubApiClient, redactGitHubSecrets } from "@t3tools/github";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopIntegrationStore from "../app/DesktopIntegrationStore.ts";

declare const __T3CODE_BUILD_GITHUB_CLIENT_ID__: string | undefined;

export class DesktopGitHubIntegrationError extends Schema.TaggedErrorClass<DesktopGitHubIntegrationError>()(
  "DesktopGitHubIntegrationError",
  { operation: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `GitHub ${this.operation} failed: ${this.detail}`;
  }
}

function githubError(
  operation: string,
  cause: unknown,
  knownSecret?: string,
): DesktopGitHubIntegrationError {
  const raw = cause instanceof Error ? cause.message : String(cause);
  return new DesktopGitHubIntegrationError({
    operation,
    detail: String(redactGitHubSecrets(raw, knownSecret ? [knownSecret] : [])),
  });
}

export class DesktopGitHubIntegration extends Context.Service<
  DesktopGitHubIntegration,
  {
    readonly status: Effect.Effect<GitHubConnectionStatus, DesktopGitHubIntegrationError>;
    readonly connectPersonalAccessToken: (
      input: GitHubPersonalAccessTokenInput,
    ) => Effect.Effect<GitHubConnectionStatus, DesktopGitHubIntegrationError>;
    readonly startDeviceAuthorization: Effect.Effect<
      GitHubDeviceAuthorization,
      DesktopGitHubIntegrationError
    >;
    readonly pollDeviceAuthorization: Effect.Effect<
      GitHubConnectionStatus,
      DesktopGitHubIntegrationError
    >;
    readonly disconnect: Effect.Effect<void, DesktopGitHubIntegrationError>;
    readonly listRepositories: (
      input: GitHubRepositoryListInput,
    ) => Effect.Effect<GitHubRepositoryListResult, DesktopGitHubIntegrationError>;
    readonly syncCredential: (
      input: DesktopGitHubCredentialSyncInput,
    ) => Effect.Effect<boolean, DesktopGitHubIntegrationError>;
  }
>()("@t3tools/desktop/github/DesktopGitHubIntegration") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const store = yield* DesktopIntegrationStore.DesktopIntegrationStore;
  const httpClient = yield* HttpClient.HttpClient;
  const buildClientId =
    typeof __T3CODE_BUILD_GITHUB_CLIENT_ID__ === "undefined"
      ? ""
      : __T3CODE_BUILD_GITHUB_CLIENT_ID__.trim();
  const configuredClientId =
    Option.getOrNull(environment.githubClientId) ?? (buildClientId || null);
  const synchronizedEnvironments = yield* Ref.make(
    new Map<string, { readonly accessToken: string }>(),
  );
  const deviceFlow = configuredClientId
    ? new GitHubDeviceFlow({ clientId: configuredClientId, scopes: ["repo", "read:org"] })
    : null;
  let cachedApi: {
    readonly token: string;
    readonly client: ReturnType<typeof makeGitHubApiClient>;
  } | null = null;

  const apiForToken = (token: string) => {
    if (cachedApi?.token === token) return cachedApi.client;
    const client = makeGitHubApiClient({ token });
    cachedApi = { token, client };
    return client;
  };

  const wrap = <A>(operation: string, action: () => Promise<A>, secret?: string) =>
    Effect.tryPromise({
      try: action,
      catch: (cause) => githubError(operation, cause, secret),
    });

  const disconnectedStatus = (detail: string | null = null): GitHubConnectionStatus => ({
    state: "disconnected",
    mode: null,
    account: null,
    expiresAt: null,
    detail,
    deviceFlowConfigured: deviceFlow !== null,
  });

  const clearSynchronizedCredentials = Effect.gen(function* () {
    const environments = yield* Ref.get(synchronizedEnvironments);
    yield* Effect.forEach(
      environments,
      ([httpBaseUrl, access]) => {
        const endpoint = new URL("/api/source-control/github/credential", httpBaseUrl);
        return HttpClientRequest.delete(endpoint).pipe(
          HttpClientRequest.bearerToken(access.accessToken),
          httpClient.execute,
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.ignore,
        );
      },
      { concurrency: "unbounded", discard: true },
    );
    yield* Ref.set(synchronizedEnvironments, new Map());
  });

  yield* Effect.addFinalizer(() => clearSynchronizedCredentials);

  const status = store.getGitHubCredential.pipe(
    Effect.mapError((cause) => githubError("load-credential", cause)),
    Effect.map(
      Option.match({
        onNone: () => disconnectedStatus(),
        onSome: (credential): GitHubConnectionStatus => ({
          state: "connected",
          mode: credential.mode,
          account: credential.account,
          expiresAt: credential.expiresAt,
          detail: null,
          deviceFlowConfigured: deviceFlow !== null,
        }),
      }),
    ),
  );

  const persistToken = Effect.fn("desktop.github.persistToken")(function* (input: {
    readonly token: string;
    readonly mode: "device" | "personal-access-token";
  }) {
    const account = yield* wrap(
      "validate-credential",
      () => apiForToken(input.token).getAccount(),
      input.token,
    );
    yield* store
      .setGitHubCredential({ mode: input.mode, token: input.token, account, expiresAt: null })
      .pipe(Effect.mapError((cause) => githubError("save-credential", cause, input.token)));
    return {
      state: "connected",
      mode: input.mode,
      account,
      expiresAt: null,
      detail: null,
      deviceFlowConfigured: deviceFlow !== null,
    } satisfies GitHubConnectionStatus;
  });

  return DesktopGitHubIntegration.of({
    status,
    connectPersonalAccessToken: (input) =>
      persistToken({ token: input.token, mode: "personal-access-token" }),
    startDeviceAuthorization: Effect.gen(function* () {
      if (!deviceFlow) {
        return yield* githubError(
          "device-authorization",
          "Device authorization is not configured for this build. Set T3CODE_GITHUB_CLIENT_ID or use a personal access token.",
        );
      }
      const authorization = yield* wrap("device-authorization", () => deviceFlow.start());
      const now = yield* Clock.currentTimeMillis;
      return {
        userCode: authorization.userCode,
        verificationUri: authorization.verificationUri,
        expiresAt: DateTime.formatIso(
          DateTime.makeUnsafe(now + authorization.expiresInSeconds * 1_000),
        ),
        intervalSeconds: authorization.intervalSeconds,
      };
    }),
    pollDeviceAuthorization: Effect.gen(function* () {
      if (!deviceFlow) return disconnectedStatus("Device authorization is not configured.");
      const result = deviceFlow.poll();
      if (result.status === "pending") {
        return {
          state: "authorizing",
          mode: "device",
          account: null,
          expiresAt: null,
          detail: "Waiting for GitHub authorization.",
          deviceFlowConfigured: true,
        };
      }
      if (result.status === "error") {
        return {
          state: "error",
          mode: "device",
          account: null,
          expiresAt: null,
          detail: String(redactGitHubSecrets(result.error)),
          deviceFlowConfigured: true,
        };
      }
      const connected = yield* persistToken({
        token: result.authentication.token,
        mode: "device",
      });
      deviceFlow.clear();
      return connected;
    }),
    disconnect: Effect.gen(function* () {
      yield* clearSynchronizedCredentials;
      yield* store.clearGitHubCredential.pipe(
        Effect.mapError((cause) => githubError("disconnect", cause)),
      );
      cachedApi = null;
      deviceFlow?.clear();
    }),
    listRepositories: (input) =>
      Effect.gen(function* () {
        const credential = yield* store.getGitHubCredential.pipe(
          Effect.mapError((cause) => githubError("load-credential", cause)),
        );
        if (Option.isNone(credential)) {
          return yield* githubError("list-repositories", "GitHub is not connected.");
        }
        return yield* wrap(
          "list-repositories",
          () => apiForToken(credential.value.token).listRepositories(input),
          credential.value.token,
        );
      }),
    syncCredential: (input) =>
      Effect.gen(function* () {
        const credential = yield* store.getGitHubCredential.pipe(
          Effect.mapError((cause) => githubError("load-credential", cause)),
        );
        if (Option.isNone(credential)) return false;
        const endpoint = new URL("/api/source-control/github/credential", input.httpBaseUrl);
        yield* HttpClientRequest.put(endpoint).pipe(
          HttpClientRequest.bearerToken(input.environmentAccessToken),
          HttpClientRequest.bodyJsonUnsafe({
            token: credential.value.token,
            ...(credential.value.expiresAt ? { expiresAt: credential.value.expiresAt } : {}),
            // The remote copy exists only in the T3 server process and is
            // refreshed whenever that environment reconnects. Disconnecting
            // GitHub actively clears every reachable injected copy.
            ttlSeconds: 8 * 60 * 60,
          }),
          httpClient.execute,
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.mapError((cause) => githubError("sync-credential", cause, credential.value.token)),
        );
        yield* Ref.update(synchronizedEnvironments, (current) => {
          const next = new Map(current);
          next.set(input.httpBaseUrl, { accessToken: input.environmentAccessToken });
          return next;
        });
        return true;
      }),
  });
});

export const layer = Layer.effect(DesktopGitHubIntegration, make);
