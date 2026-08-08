# Cloud Sandboxes

Cloud sandboxes are managed execution environments. Configure providers under
**Settings → Connections → Cloud Sandboxes → Add sandbox provider**.

## Provider setup

Each provider stores its API key in T3 Code's secure credential store
(`ServerSecretStore`). Keys are never written to project configuration, logs,
repository files, or URLs. Secrets are masked in the UI (`••••1234`) and
redacted from logs by `redactSecrets`.

### Daytona

1. Create a Daytona API key from your Daytona dashboard.
2. **Settings → Connections → Cloud Sandboxes → Add provider → Daytona**.
3. Paste the API key and click **Validate connection**.
4. T3 provisions a sandbox, creates temporary SSH access, and bootstraps the
   T3 server inside it. The sandbox then appears as a normal saved execution
   environment.

Options exposed: template/image, region, CPU, memory, disk, timeout,
auto-stop — only where the Daytona SDK supports them.

### E2B

1. Create an E2B access key.
2. Add provider → **E2B** → paste key → **Validate connection**.
3. T3 runs the backend inside the E2B sandbox using the E2B SDK's command and
   filesystem APIs and connects over the exposed service URL.

E2B does not use the SSH transport. The environment still presents the same T3
execution environment contract to the rest of the application.

### Novita AI Agent Sandbox

1. Obtain an Agent Sandbox API key from Novita AI.
2. Add provider → **Novita** → paste key → **Validate connection**.
3. T3 connects over Novita's Agent Sandbox API.

> Only lifecycle operations each provider's SDK/API actually supports are
> exposed. If a provider has no "pause", T3 will not pretend it does.

## Sandboxes management UI

**Settings → Connections → Cloud Sandboxes** lists every sandbox with:

- provider, sandbox name, status, region (where available), resources (where
  available), associated project, creation time
- lifecycle controls: **Connect**, **Open Project**, **Pause/Stop**,
  **Resume/Start**, **Delete** (only where supported)
- cost-sensitive info (configured CPU/RAM, auto-shutdown) where the provider
  exposes it

You can create a persistent sandbox manually from Settings, or opt to create an
ephemeral sandbox when starting a new task.

## Creating a project into a sandbox

During project creation:

```
Repository:  GitHub repository
Environment: Local / SSH Remote / Cloud Sandbox
Provider:    Daytona / E2B / Novita
Sandbox:     Existing sandbox / Create new sandbox
```

You can also create an environment first from Settings and later place
projects into it.

## Security

- Provider API keys live in the secure credential store, never in project
  config or the repo.
- GitHub credentials are injected per-operation only (see
  [GitHub Integration](./github-integration.md#credential-injection)).
- Deleting a sandbox removes any materialized credentials inside that
  environment. The master GitHub credential is never persisted in a sandbox
  snapshot.
