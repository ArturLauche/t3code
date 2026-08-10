# Execution environments

T3 Code runs every project, terminal, Git command, and agent session in one of three execution
environment categories. Agent providers use the same T3 server interfaces in every category; Codex,
Claude Code, OpenCode, Cursor, Grok, and other configured providers do not need environment-specific
configuration in the client.

## Local

Local projects keep their current behavior. The desktop-managed T3 server owns the files, repository,
terminals, and agents on this device. Choose **Local** in Add Project and select an existing folder, or
choose GitHub and clone a repository into a local destination.

## SSH Remote

SSH environments preserve T3 Code's existing remote-server architecture. The desktop connects to the
host, installs or reuses the compatible T3 CLI runner, starts the T3 server on loopback, and maintains
an SSH tunnel. The remote host owns the files, Git state, terminals, and agent processes.

Add SSH hosts under **Settings → Connections**, then choose **SSH Remote** in Add Project. Existing
saved SSH environments and their credentials continue to work.

## Cloud Sandbox

Cloud sandboxes are managed execution environments. Add a provider under
**Settings → Connections → Cloud Sandboxes**, validate its API key, and then either:

- create a persistent sandbox in Settings and connect it later; or
- choose **New ephemeral sandbox** in Add Project for a task sandbox that is configured to delete
  automatically after 60 minutes.

The sandbox list shows provider-reported state, region/target, CPU, RAM, disk, project association,
creation time, automatic shutdown policy, and only the lifecycle actions the provider supports.

### Daytona

Create an API key in Daytona and add it to T3 Code. A custom API URL can be supplied for a compatible
self-hosted Daytona deployment. Daytona supports snapshots or OCI images, target/region selection,
image resource sizing, auto-stop, auto-pause, auto-delete, and full start/stop/pause/resume/delete
lifecycle operations.

T3 Code provisions the sandbox, requests temporary Daytona SSH access, and reuses the existing T3 SSH
bootstrap/tunnel implementation. The temporary SSH token remains in desktop memory, is redacted from
commands and errors, and is revoked when the connection closes.

### E2B

Create an E2B API key and optionally enter a template. E2B's current API supports command execution,
filesystem/Git access through the sandbox runtime, public port discovery, pause/resume, delete,
timeout behavior, and automatic resume. It does not expose the SSH lifecycle expected by T3's SSH
transport, so T3 launches the backend using E2B's command API and connects through the exposed service
URL. Start/stop buttons are not shown because those operations are not provided by this adapter.

### Novita AI Agent Sandbox

Create a Novita API key and optionally enter a template and node ID. The Novita adapter uses its Agent
Sandbox command and endpoint APIs, with pause/resume, delete, timeout behavior, and automatic resume.
As with E2B, T3 runs its authenticated backend on an exposed sandbox port instead of presenting a
fictional SSH transport.

## Creating a GitHub project

1. Connect GitHub once under **Settings → Source Control → GitHub**.
2. Open **Add Project**.
3. Choose Local, an SSH environment, an existing connected cloud sandbox, or a new ephemeral sandbox.
4. Choose **GitHub repository**, search the authenticated account's repositories, and select one.
5. Choose the destination directory. The clone and all later Git/agent operations run in the selected
   environment.

Sandboxes created first in Settings can be connected and selected in Add Project. After a project is
created, T3 stores a non-secret sandbox/project association so **Open Project** can return to it.

## Security model

- Sandbox API keys and the central GitHub credential are stored in one OS-encrypted desktop secret
  document. They are never stored in project settings, clone URLs, Git config, shell history, or the
  repository.
- Provider errors and SSH command diagnostics redact known API keys and temporary Daytona access
  tokens.
- E2B and Novita service ports are reachable through provider URLs, but the T3 server still requires
  its scoped bearer authentication.
- GitHub credentials are injected into the environment T3 server's memory. Individual `git` processes
  receive `GIT_ASKPASS`; the helper script contains no token. `gh` receives its token only in that
  process environment.
- Disconnecting GitHub clears reachable environment copies. Closing the desktop clears reachable
  copies as well; unreachable copies expire automatically. Deleting a sandbox destroys its runtime
  filesystem and any in-memory credential material.
- Provider snapshots must not be created while a manually injected credential is materialized. T3's
  own flow does not write the master GitHub credential to the sandbox filesystem.

Provider SDK behavior can change. T3 deliberately hides unsupported controls instead of simulating
them; consult the provider's current limits and billing page before selecting resource sizes or long
timeouts.
