# GitHub Integration

T3 Code's GitHub integration is designed to feel like OpenHands Cloud while
remaining usable as a self-hosted/local application. One GitHub connection is
usable across Local, SSH Remote, and Cloud Sandbox environments.

## Connecting GitHub

**Settings → Source Control → GitHub → Connect GitHub**.

Supported authentication modes:

| Mode | When to use | Notes |
| --- | --- | --- |
| **Device flow** (default) | Local / self-hosted, headless, or over SSH | OAuth device authorization grant; no `gh auth login` required |
| **Personal Access Token** | Advanced users | Fine-grained PAT preferred |
| **GitHub App** | Deployments with a backend | Short-lived installation/user tokens from a GitHub App |
| **`gh` CLI** | Backward compatibility | `gh auth login` remains a fallback |

The REST client uses Effect's `HttpClient` against GitHub's REST API rather
than shelling out to `gh` for every request. `gh` is still supported for
operations where it already works well.

## Repository picker

After connecting, the Add Project flow shows a repository picker so you can
browse/search your repositories directly instead of typing `owner/repo`.
Private and public repos are cloneable. Normal Git functionality (fetch,
branch, commit, push, pull) is preserved afterwards.

## Repository metadata and actions

Inside T3 Code you get:

- current repository and branch, default branch, remote URL
- the open pull request for the current branch (title, status, link)
- pull request creation
- relevant issues where practical
- opening the repository / PR on GitHub

These reuse T3's existing source control implementation rather than
duplicating it.

## Credential injection

Credentials are never embedded in Git clone URLs, written to `.git/config`,
shell history, or ordinary environment configuration. Instead,
`GitHubCredentialInjector` chooses an injection strategy per environment:

| Environment | Strategy | What happens |
| --- | --- | --- |
| **Local** | `local-askpass` | An ephemeral `GIT_ASKPASS` helper script is created in the OS temp dir, used for the operation, then deleted. `GIT_TERMINAL_PROMPT=0`. |
| **SSH Remote** | `remote-askpass` | An ephemeral credential is forwarded to the remote T3 server / Git process for the duration of the operation. The user's persistent global Git config is not modified unless explicitly necessary. |
| **Cloud Sandbox** | `remote-ephemeral` | Credentials are injected only when cloning/fetching/pushing, then removed. Deleting the sandbox removes any materialized credentials. |

The master GitHub credential is never persisted in a sandbox snapshot.

`redactSecrets` masks GitHub PATs, fine-grained tokens, Bearer headers,
`token=`/`api_key=` assignments, and embedded URL credentials from logs and
error output.

## One connection, all environments

GitHub does not need separate implementations for Daytona, E2B, and Novita.
It interacts with the common execution environment interface
(`ExecutionEnvironmentAdapter`), so the same connection works everywhere.
