import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

/**
 * How a GitHub connection was authenticated. The connection abstraction keeps
 * the actual token out of these records — credentials live in the secure store
 * and are referenced by `credentialKey`. This record only describes the mode so
 * the UI and injection logic can pick the right path.
 *
 * - `device-flow` — OAuth device authorization grant. Works for self-hosted /
 *   local installs with no backend, and inside SSH sessions (no loopback
 *   browser). Produces short-lived, refreshable tokens.
 * - `pat` — Personal Access Token. Advanced users; fine-grained PATs preferred.
 * - `gh-cli` — `gh auth login` is the source of truth. Preserved for backward
 *   compatibility; T3 reads the active `gh` account rather than storing a token.
 * - `github-app` — installation/user token minted from a GitHub App. Requires a
 *   backend capable of holding the App private key; produces short-lived tokens.
 */
export const GitHubAuthMode = Schema.Literals([
  "device-flow",
  "pat",
  "gh-cli",
  "github-app",
]);
export type GitHubAuthMode = typeof GitHubAuthMode.Type;

/**
 * A GitHub connection. One connection is usable across Local, SSH Remote and
 * Cloud Sandbox environments — the credential is never copied onto a remote
 * machine; it is injected ephemerally per operation (GIT_ASKPASS / temporary
 * env / short-lived remote token).
 */
export const GitHubConnection = Schema.Struct({
  /** Stable id for the connection record. */
  id: TrimmedNonEmptyString,
  mode: GitHubAuthMode,
  /** Account login resolved from the credential, when known. */
  account: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  /** Host — `github.com` or a GHES host. */
  host: TrimmedNonEmptyString,
  /**
   * Key into the secure credential store. The credential itself never appears
   * in this record, project config, logs, or URLs.
   */
  credentialKey: TrimmedNonEmptyString,
  createdAt: Schema.String,
  lastValidatedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type GitHubConnection = typeof GitHubConnection.Type;

/** Result of validating a GitHub credential. */
export const GitHubConnectionValidationResult = Schema.Struct({
  ok: Schema.Boolean,
  account: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  detail: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
});
export type GitHubConnectionValidationResult = typeof GitHubConnectionValidationResult.Type;

/** A repository surfaced by the repository picker. */
export const GitHubRepositorySummary = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  owner: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
  isPrivate: Schema.Boolean,
  defaultBranch: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  description: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  updatedAt: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
});
export type GitHubRepositorySummary = typeof GitHubRepositorySummary.Type;

export const GitHubRepositoryListResult = Schema.Struct({
  repositories: Schema.Array(GitHubRepositorySummary),
  /** Whether the listing is the authenticated account's own repos vs. a search. */
  source: Schema.Literals(["owned", "search"]),
});
export type GitHubRepositoryListResult = typeof GitHubRepositoryListResult.Type;

/**
 * Credential injection strategy for an environment. The GitHub integration
 * interacts with the common execution environment interface, not provider
 * specifics, so this is the only place a provider distinction leaks through.
 *
 * - `local-askpass` — write an ephemeral GIT_ASKPASS script for the local git
 *   process; never writes to `.git/config`.
 * - `remote-ephemeral` — mint a short-lived credential for the remote T3 server
 *   / git process for the duration of the operation; never persists on the
 *   remote host.
 * - `remote-askpass` — SSH transport: set GIT_ASKPASS on the remote git process
 *   via the T3 SSH command channel.
 */
export const GitHubCredentialInjection = Schema.Literals([
  "local-askpass",
  "remote-ephemeral",
  "remote-askpass",
]);
export type GitHubCredentialInjection = typeof GitHubCredentialInjection.Type;

/** Re-exported so callers can map the connection to the source-control kind. */
export const GitHubSourceControlKind: SourceControlProviderKind = "github";
