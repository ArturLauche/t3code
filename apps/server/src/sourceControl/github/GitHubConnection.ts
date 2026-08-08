import {
  type GitHubConnection,
  type GitHubConnectionValidationResult,
  type GitHubRepositorySummary,
  type GitHubRepositoryListResult,
  type GitHubAuthMode,
} from "@t3tools/contracts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { redactSecrets } from "../../executionEnvironment/cloud/SandboxCredentialStore.ts";

/**
 * GitHub connection abstraction.
 *
 * One GitHub connection is usable across Local, SSH Remote and Cloud Sandbox
 * environments. The credential itself lives in the secure store (referenced by
 * `credentialKey`) and is never copied onto a remote machine or embedded in Git
 * clone URLs. Per-operation injection is handled by {@link GitHubCredentialInjector}.
 *
 * Supported modes:
 * - `device-flow` — OAuth device authorization grant (works headless / over SSH).
 * - `pat` — Personal Access Token (advanced users; fine-grained preferred).
 * - `gh-cli` — `gh auth login` is the source of truth (backward compatibility).
 * - `github-app` — short-lived installation/user token from a GitHub App (needs a backend).
 *
 * The REST client uses Effect's HttpClient against GitHub's REST API rather than
 * shelling out to `gh` for every request. `gh` remains a fallback for operations
 * where it already works well (see GitHubCli).
 */

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const SECRET_PREFIX = "github-connection/";
const DEFAULT_DEVICE_CLIENT_ID = "Ov23liGEphvWY9YQzGxv";

/** T3 Code's own OAuth client id for the device flow; overridable for self-hosted. */
const DEVICE_CLIENT_ID =
  process.env.T3CODE_GITHUB_OAUTH_CLIENT_ID?.trim() || DEFAULT_DEVICE_CLIENT_ID;

export class GitHubConnectionError extends Schema.TaggedErrorClass<GitHubConnectionError>()(
  "GitHubConnectionError",
  {
    operation: Schema.String,
    mode: Schema.optionalKey(Schema.String),
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `GitHub connection ${this.operation} failed: ${redactSecrets(this.detail)}`;
  }
}

const toBytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const fromBytes = (value: Uint8Array): string => new TextDecoder().decode(value);

const GitHubUserSchema = Schema.Struct({
  login: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
});
const GitHubRepoSchema = Schema.Struct({
  full_name: Schema.String,
  name: Schema.String,
  owner: Schema.Struct({ login: Schema.String }),
  html_url: Schema.String,
  ssh_url: Schema.String,
  private: Schema.Boolean,
  default_branch: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
});

/** Stored GitHub connection records (non-secret metadata only). */
export class GitHubConnectionStore extends Context.Service<
  GitHubConnectionStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<GitHubConnection>>;
    readonly get: (id: string) => Effect.Effect<GitHubConnection, GitHubConnectionError>;
    readonly upsert: (connection: GitHubConnection) => Effect.Effect<void, GitHubConnectionError>;
    readonly remove: (id: string) => Effect.Effect<void, GitHubConnectionError>;
    /** Resolve the credential value for a connection (never log this). */
    readonly resolveCredential: (
      connection: GitHubConnection,
    ) => Effect.Effect<string, GitHubConnectionError>;
    /** Store a credential value under the connection's credentialKey. */
    readonly storeCredential: (
      credentialKey: string,
      secret: string,
    ) => Effect.Effect<void, GitHubConnectionError>;
  }
>()("t3/sourceControl/github/GitHubConnectionStore") {}

/** Device-flow authorization state surfaced to the UI. */
export interface GitHubDeviceFlowAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresInSeconds: number;
  readonly intervalSeconds: number;
}

const DeviceCodeResponseSchema = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.Number,
});

const TokenResponseSchema = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
  interval: Schema.optional(Schema.Number),
});

/**
 * GitHub client service: validates credentials, lists repositories, and drives
 * the device flow. All HTTP goes through Effect's HttpClient; secrets are masked
 * in errors via {@link redactSecrets}.
 */
export class GitHubClient extends Context.Service<
  GitHubClient,
  {
    readonly requestDeviceCode: Effect.Effect<GitHubDeviceFlowAuthorization, GitHubConnectionError>;
    readonly awaitDeviceAuthorization: (
      deviceCode: string,
      intervalSeconds: number,
    ) => Effect.Effect<string, GitHubConnectionError>;
    readonly validateCredential: (
      host: string,
      credential: string,
    ) => Effect.Effect<GitHubConnectionValidationResult, GitHubConnectionError>;
    readonly listRepositories: (input: {
      readonly host: string;
      readonly credential: string;
      readonly query?: string;
      readonly limit?: number;
    }) => Effect.Effect<GitHubRepositoryListResult, GitHubConnectionError>;
  }
>()("t3/sourceControl/github/GitHubClient") {}

const apiBaseFor = (host: string): string =>
  host === "github.com" ? GITHUB_API_BASE : `https://${host}/api/v3`;

const withAuth = (
  request: HttpClientRequest.HttpClientRequest,
  credential: string,
): HttpClientRequest.HttpClientRequest =>
  request.pipe(
    HttpClientRequest.bearerToken(credential),
    HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
    HttpClientRequest.setHeader("x-github-api-version", "2022-11-28"),
    HttpClientRequest.setHeader("user-agent", "t3-code"),
  );

const decodeResponse = <S extends Schema.Top>(
  operation: string,
  schema: S,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<Option.Option<S["Type"]>, GitHubConnectionError, S["DecodingServices"]> =>
  HttpClientResponse.matchStatus({
    "2xx": (success) =>
      HttpClientResponse.schemaBodyJson(schema)(success).pipe(
        Effect.map(Option.some),
        Effect.mapError(
          (cause) =>
            new GitHubConnectionError({
              operation,
              detail: `GitHub returned an unexpected response for ${operation}.`,
              cause: cause as never,
            }),
        ),
      ),
    orElse: (failed) =>
      Effect.fail(
        new GitHubConnectionError({
          operation,
          detail: `GitHub API request for ${operation} failed with status ${failed.status}.`,
        }),
      ),
  })(response);

const executeJson = <S extends Schema.Top>(
  httpClient: HttpClient.HttpClient,
  operation: string,
  request: HttpClientRequest.HttpClientRequest,
  credential: string,
  schema: S,
): Effect.Effect<Option.Option<S["Type"]>, GitHubConnectionError, S["DecodingServices"]> =>
  httpClient.execute(withAuth(request, credential)).pipe(
    Effect.mapError(
      (cause) =>
        new GitHubConnectionError({
          operation,
          detail: `GitHub API request for ${operation} failed.`,
          cause: cause as never,
        }),
    ),
    Effect.flatMap((response) => decodeResponse(operation, schema, response)),
  );

export const makeGitHubClient = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;

  const requestDeviceCode = Effect.gen(function* () {
    const request = HttpClientRequest.post(GITHUB_DEVICE_CODE_URL).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.setHeader("user-agent", "t3-code"),
      HttpClientRequest.bodyUrlParams({
        client_id: DEVICE_CLIENT_ID,
        scope: "repo read:org",
      }),
    );
    const decoded = yield* httpClient
      .execute(request)
      .pipe(
        Effect.flatMap((response) => decodeResponse("requestDeviceCode", DeviceCodeResponseSchema, response)),
        Effect.mapError(
          (cause) =>
            cause instanceof GitHubConnectionError
              ? cause
              : new GitHubConnectionError({
                  operation: "requestDeviceCode",
                  detail: "Could not start the GitHub device authorization flow.",
                  cause: cause as never,
                }),
        ),
      );
    if (Option.isNone(decoded)) {
      return yield* new GitHubConnectionError({
        operation: "requestDeviceCode",
        detail: "GitHub returned an empty device-code response.",
      });
    }
    const value = decoded.value;
    return {
      deviceCode: value.device_code,
      userCode: value.user_code,
      verificationUri: value.verification_uri,
      expiresInSeconds: value.expires_in,
      intervalSeconds: value.interval,
    } satisfies GitHubDeviceFlowAuthorization;
  });

  const pollToken = Effect.fn("GitHubClient.pollToken")(function* (input: {
    readonly deviceCode: string;
    readonly intervalSeconds: number;
  }) {
    const request = HttpClientRequest.post(GITHUB_TOKEN_URL).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.setHeader("user-agent", "t3-code"),
      HttpClientRequest.bodyUrlParams({
        client_id: DEVICE_CLIENT_ID,
        device_code: input.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    );
    const decoded = yield* httpClient
      .execute(request)
      .pipe(
        Effect.flatMap((response) => decodeResponse("awaitDeviceAuthorization", TokenResponseSchema, response)),
        Effect.mapError(
          (cause) =>
            cause instanceof GitHubConnectionError
              ? cause
              : new GitHubConnectionError({
                  operation: "awaitDeviceAuthorization",
                  detail: "GitHub token endpoint request failed.",
                  cause: cause as never,
                }),
        ),
      );
    const value = Option.getOrUndefined(decoded);
    if (value?.access_token) {
      return value.access_token;
    }
    if (value?.error === "authorization_pending" || value?.error === "slow_down") {
      return yield* Effect.fail(
        new GitHubConnectionError({
          operation: "awaitDeviceAuthorization",
          detail: "authorization_pending",
        }),
      );
    }
    return yield* new GitHubConnectionError({
      operation: "awaitDeviceAuthorization",
      detail: value?.error_description ?? value?.error ?? "GitHub authorization failed.",
    });
  });

  const awaitDeviceAuthorization = (
    deviceCode: string,
    intervalSeconds: number,
  ): Effect.Effect<string, GitHubConnectionError> =>
    pollToken({ deviceCode, intervalSeconds }).pipe(
      Effect.retry(
        Schedule.exponential(`${Math.max(intervalSeconds, 5)} seconds`).pipe(
          Schedule.upTo({ duration: "15 minutes" }),
        ),
      ),
    );

  const validateCredential = (host: string, credential: string) =>
    executeJson(
      httpClient,
      "validateCredential",
      HttpClientRequest.get(`${apiBaseFor(host)}/user`),
      credential,
      GitHubUserSchema,
    ).pipe(
      Effect.match({
        onFailure: () =>
          ({ ok: false, detail: "The GitHub credential was rejected." }) satisfies GitHubConnectionValidationResult,
        onSuccess: (decoded) =>
          Option.match(decoded, {
            onNone: () =>
              ({ ok: false, detail: "The GitHub credential was rejected." }) satisfies GitHubConnectionValidationResult,
            onSome: (value) =>
              ({ ok: true, account: value.login, detail: null }) satisfies GitHubConnectionValidationResult,
          }),
      }),
    );

  const GitHubRepoListSchema = Schema.Array(GitHubRepoSchema);
const GitHubRepoSearchSchema = Schema.Struct({ items: Schema.Array(GitHubRepoSchema) });

const listRepositories = (input: {
    readonly host: string;
    readonly credential: string;
    readonly query?: string;
    readonly limit?: number;
  }) =>
    Effect.gen(function* () {
      const limit = Math.min(input.limit ?? 50, 100);
      const isSearch = input.query !== undefined;
      const url = isSearch
        ? `${apiBaseFor(input.host)}/search/repositories?q=${encodeURIComponent(input.query!)}&per_page=${limit}`
        : `${apiBaseFor(input.host)}/user/repos?per_page=${limit}&sort=updated`;
      const decoded = yield* executeJson(
        httpClient,
        "listRepositories",
        HttpClientRequest.get(url),
        input.credential,
        isSearch ? GitHubRepoSearchSchema : GitHubRepoListSchema,
      );
      const raw = Option.getOrUndefined(decoded);
      const items: ReadonlyArray<typeof GitHubRepoSchema.Type> = isSearch
        ? ((raw as { items?: typeof GitHubRepoSchema.Type[] } | undefined)?.items ?? [])
        : ((raw as typeof GitHubRepoSchema.Type[] | undefined) ?? []);
      const repositories: Array<GitHubRepositorySummary> = items.map((repo) => ({
        nameWithOwner: repo.full_name,
        owner: repo.owner.login,
        name: repo.name,
        url: repo.html_url,
        sshUrl: repo.ssh_url,
        isPrivate: repo.private,
        defaultBranch: repo.default_branch ?? null,
        description: repo.description ?? null,
        updatedAt: repo.updated_at ?? null,
      }));
      return {
        repositories,
        source: isSearch ? ("search" as const) : ("owned" as const),
      } satisfies GitHubRepositoryListResult;
    });

  return GitHubClient.of({
    requestDeviceCode,
    awaitDeviceAuthorization,
    validateCredential,
    listRepositories,
  });
});

export const githubClientLayer = Layer.effect(GitHubClient, makeGitHubClient);

/** Construct a new GitHub connection record (credential stored separately). */
export const createGitHubConnection = (input: {
  readonly mode: GitHubAuthMode;
  readonly account?: string | null;
  readonly host?: string;
  readonly credentialKey?: string;
}): Effect.Effect<GitHubConnection, PlatformError.PlatformError, Crypto.Crypto> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const id = yield* crypto.randomUUIDv4;
    const credentialKey = input.credentialKey ?? `gh-${id}`;
    return {
      id,
      mode: input.mode,
      account: input.account ?? null,
      host: input.host ?? "github.com",
      credentialKey,
      createdAt: new Date().toISOString(),
    } satisfies GitHubConnection;
  });

export const makeGitHubConnectionStore = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const records = new Map<string, GitHubConnection>();

  return GitHubConnectionStore.of({
    list: Effect.sync(() => [...records.values()]),
    get: (id) =>
      Effect.gen(function* () {
        const record = records.get(id);
        if (!record) {
          return yield* new GitHubConnectionError({
            operation: "get",
            detail: "No GitHub connection is registered with this id.",
          });
        }
        return record;
      }),
    upsert: (connection) =>
      Effect.sync(() => {
        records.set(connection.id, connection);
      }),
    remove: (id) =>
      Effect.gen(function* () {
        const record = records.get(id);
        if (record) {
          yield* secrets.remove(`${SECRET_PREFIX}${record.credentialKey}`).pipe(Effect.ignore);
          records.delete(id);
        }
      }),
    resolveCredential: (connection) =>
      secrets.get(`${SECRET_PREFIX}${connection.credentialKey}`).pipe(
        Effect.map(Option.match({ onNone: () => null, onSome: fromBytes })),
        Effect.flatMap((value) =>
          value
            ? Effect.succeed(value)
            : Effect.fail(
                new GitHubConnectionError({
                  operation: "resolveCredential",
                  detail: "No credential is stored for this GitHub connection.",
                }),
              ),
        ),
        Effect.mapError(
          (cause) =>
            new GitHubConnectionError({
              operation: "resolveCredential",
              detail: "Could not read the GitHub credential from the secure store.",
              cause: cause as never,
            }),
        ),
      ),
    storeCredential: (credentialKey, secret) =>
      secrets.set(`${SECRET_PREFIX}${credentialKey}`, toBytes(secret)).pipe(
        Effect.mapError(
          (cause) =>
            new GitHubConnectionError({
              operation: "storeCredential",
              detail: "Could not store the GitHub credential in the secure store.",
              cause: cause as never,
            }),
        ),
      ),
  });
});

export const githubConnectionStoreLayer = Layer.effect(
  GitHubConnectionStore,
  makeGitHubConnectionStore,
);
