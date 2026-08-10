import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const GitHubConnectionMode = Schema.Literals([
  "device",
  "personal-access-token",
  "github-app",
  "gh-cli",
]);
export type GitHubConnectionMode = typeof GitHubConnectionMode.Type;

export const GitHubConnectionState = Schema.Literals([
  "disconnected",
  "authorizing",
  "connected",
  "error",
]);
export type GitHubConnectionState = typeof GitHubConnectionState.Type;

export const GitHubAccount = Schema.Struct({
  login: TrimmedNonEmptyString,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  profileUrl: TrimmedNonEmptyString,
});
export type GitHubAccount = typeof GitHubAccount.Type;

export const GitHubConnectionStatus = Schema.Struct({
  state: GitHubConnectionState,
  mode: Schema.NullOr(GitHubConnectionMode),
  account: Schema.NullOr(GitHubAccount),
  expiresAt: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
  deviceFlowConfigured: Schema.Boolean,
});
export type GitHubConnectionStatus = typeof GitHubConnectionStatus.Type;

export const GitHubPersonalAccessTokenInput = Schema.Struct({
  token: TrimmedNonEmptyString,
});
export type GitHubPersonalAccessTokenInput = typeof GitHubPersonalAccessTokenInput.Type;

export const GitHubDeviceAuthorization = Schema.Struct({
  userCode: TrimmedNonEmptyString,
  verificationUri: TrimmedNonEmptyString,
  expiresAt: TrimmedNonEmptyString,
  intervalSeconds: PositiveInt,
});
export type GitHubDeviceAuthorization = typeof GitHubDeviceAuthorization.Type;

export const GitHubRepositorySummary = Schema.Struct({
  id: PositiveInt,
  name: TrimmedNonEmptyString,
  nameWithOwner: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  url: TrimmedNonEmptyString,
  cloneUrl: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
  defaultBranch: TrimmedNonEmptyString,
  private: Schema.Boolean,
  archived: Schema.Boolean,
  pushedAt: Schema.NullOr(Schema.String),
});
export type GitHubRepositorySummary = typeof GitHubRepositorySummary.Type;

export const GitHubRepositoryListInput = Schema.Struct({
  query: Schema.optionalKey(Schema.String),
  page: Schema.optionalKey(PositiveInt),
  perPage: Schema.optionalKey(PositiveInt),
});
export type GitHubRepositoryListInput = typeof GitHubRepositoryListInput.Type;

export const GitHubRepositoryListResult = Schema.Struct({
  repositories: Schema.Array(GitHubRepositorySummary),
  page: PositiveInt,
  hasNextPage: Schema.Boolean,
});
export type GitHubRepositoryListResult = typeof GitHubRepositoryListResult.Type;

export const GitHubCredentialInjectionInput = Schema.Struct({
  token: TrimmedNonEmptyString,
  expiresAt: Schema.optionalKey(Schema.String),
  ttlSeconds: Schema.optionalKey(NonNegativeInt),
});
export type GitHubCredentialInjectionInput = typeof GitHubCredentialInjectionInput.Type;

export class GitHubIntegrationError extends Schema.TaggedErrorClass<GitHubIntegrationError>()(
  "GitHubIntegrationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `GitHub ${this.operation} failed: ${this.detail}`;
  }
}
