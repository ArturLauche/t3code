# Execution Environments

T3 Code supports three first-class execution environment categories. An agent
provider (Codex, Claude Code, OpenCode, Freebuff CLI, …) talks to the same T3
server interfaces regardless of where the project actually executes.

| Category | Where agents run | Files / Git / terminals owned by |
| --- | --- | --- |
| **Local** | The user's machine | The local filesystem |
| **SSH Remote** | A remote host over SSH | The remote host |
| **Cloud Sandbox** | A managed sandbox (Daytona, E2B, Novita) | The sandbox |

All three implement the same `ExecutionEnvironmentAdapter` contract, so the
rest of T3 Code never needs provider-specific conditionals.

## The execution environment contract

```
ExecutionEnvironmentAdapter
  capabilities         // category, providerKind, lifecycle booleans
  create / reconnect / status
  bootstrap / executeCommand / filesystemLocation
  start / stop / pause / resume / delete   (where supported)
  resolveContract       // ExecutionEnvironmentContract for the rest of T3
```

`ExecutionEnvironmentRegistry` resolves an adapter from a `category`
(local / ssh-remote / cloud) plus an optional `providerKind`, then provisions
or reconnects the environment and returns the `ExecutionEnvironmentContract`
the rest of the application uses to talk to the T3 server.

## Local

`LocalExecutionEnvironment` is the default. It keeps the existing local
project behaviour unchanged — local filesystem, local Git, local terminals.
No provisioning step is required; the desktop process is the T3 server.

## SSH Remote

`SshRemoteExecutionEnvironment` preserves the existing T3 SSH architecture: T3
starts (or reuses) a T3 server on the remote host, and the remote host owns
the files, Git state, terminals and agent sessions. The adapter only adapts
that flow to the common environment contract.

## Cloud Sandbox

`SandboxProviderAdapter` is the provider interface. T3 Code ships three
adapters, each behind the same interface so new providers can be added without
touching the rest of the application:

- **Daytona** — provisions a sandbox, creates temporary SSH access, and bootstraps
  the T3 server inside it, reusing the existing SSH bootstrap. Lifecycle
  operations match what the `@daytona/sdk` actually supports.
- **E2B** — uses the E2B TypeScript sandbox SDK's command/filesystem/lifecycle
  APIs. Because E2B's networking model is not SSH, the adapter exposes an HTTP
  transport target rather than pretending SSH is available.
- **Novita AI Agent Sandbox** — uses Novita's Agent Sandbox API. Like E2B, it
  exposes an HTTP transport target.

Each adapter only declares the lifecycle operations (`create`, `start`, `stop`,
`pause`, `resume`, `delete`, `resourceInfo`, `region`, `autoStop`) the provider
actually supports. Unsupported operations fail with a `SandboxProviderError`
rather than silently no-op'ing.

See [Cloud Sandboxes](./cloud-sandboxes.md) for provider setup.
