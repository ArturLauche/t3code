# GitHub connection

T3 Code supports one central GitHub connection across Local, SSH Remote, and Cloud Sandbox execution
environments. Existing `gh` CLI authentication remains available as a fallback.

## Connection modes

### Device authorization

Desktop builds configured with `T3CODE_GITHUB_CLIENT_ID` show **Connect GitHub**. The desktop opens
GitHub's device page, displays a one-time code, and polls until authorization completes. The client ID
must belong to your own GitHub OAuth app with Device Flow enabled; it is public application metadata,
not a client secret.

For a fork build, set the `T3CODE_GITHUB_CLIENT_ID` GitHub Actions repository variable. Do not add a
GitHub OAuth client secret to a desktop build.

### Fine-grained personal access token

The advanced **Use personal access token** flow is always available in the desktop app. Prefer a
fine-grained token restricted to the repositories and organization access required for your work.
T3 validates the token before saving it in the native OS secure store.

### GitHub App deployments

The stored authentication mode and API client are intentionally separated from the project and
execution-environment layers. A hosted deployment that can protect GitHub App private credentials can
implement installation/user-token exchange and supply short-lived tokens through the same credential
broker. Private GitHub App credentials must never be compiled into this desktop client.

### `gh` compatibility

When no central connection is configured, T3's existing source-control discovery and `gh auth` setup
continue to work. This is useful on a host that already has an independent machine identity.

## Repository and pull-request behavior

The Add Project picker uses Octokit to list repositories visible to the authenticated account,
including private repositories, and always clones with a clean HTTPS URL. Repository state, branch
operations, fetch/pull/push, pull-request metadata and creation, and links to GitHub continue through
T3 Code's existing Git/VCS and source-control provider services. The central token is made available to
those services without changing the project remote URL.

## Credential handling

T3 never embeds a token in a clone URL or `.git/config`. For each connected T3 server, the desktop
sends the credential over that environment's authenticated endpoint. The server keeps it in memory
with an expiry and gives a Git process a secret-free `GIT_ASKPASS` script plus a process-scoped token
environment. It does not change global Git configuration.

For SSH hosts, this means the user's master token is not copied to a persistent remote credential
store. For cloud sandboxes, it is not included in sandbox creation metadata or snapshots. Disconnect
GitHub to revoke reachable injected copies, and revoke the OAuth grant or PAT in GitHub if a credential
may have been exposed.
