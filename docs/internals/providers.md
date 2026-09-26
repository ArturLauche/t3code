# Provider constraints

Orchestration records intent and state without knowing which provider runs a thread. Provider
protocols, account ownership, permissions, and capabilities belong at the
[adapter boundary](../../apps/server/src/provider/Services/ProviderAdapter.ts). Normalize there
instead of spreading provider checks through reactors and clients.

A driver kind identifies an integration; an instance identifies one configuration and account
lifecycle. Route work by instance, so two accounts using the same driver do not share mutable
session or catalog state.

## Process and account isolation

T3-managed OpenCode chat uses one server per thread. Its MCP registrations are directory-scoped, while
T3's MCP connection is thread-scoped. Sharing a chat server between threads in one directory would
let them replace each other's connection. Catalog and text-generation work can share the
[instance-owned helper](../../apps/server/src/provider/OpenCodeServerOwner.ts), which closes
after an idle period. External OpenCode servers remain externally owned and can require an
external restart to pick up configuration changes.

OpenCode also stores persistent approval grants per directory. Automatic full-access replies use
`once` so they cannot widen a supervised thread's permissions on a shared external server.
See the [adapter](../../apps/server/src/provider/Layers/OpenCodeAdapter.ts).

Antigravity separates account profiles per instance while sharing installed executables across the
environment. It forces file-based credential storage because the native macOS keychain entry would
otherwise be shared across instances. The launch environment removes ambient Google credentials,
so an instance cannot silently use another account or billing project. The agent also resolves
its user-global skill directories under that profile, so the profile links those two directories
back to the user's real `~/.gemini`; MCP servers, hooks, and rules there stay out of the profile.
See [profile isolation](../../apps/server/src/provider/antigravityAuthSupport.ts).

The [Antigravity installer](../../apps/server/src/provider/AntigravityInstallation.ts) outlives
client connections and provider-instance rebuilds. Releases are immutable, with an atomic pointer
selecting the version for new processes. Running processes hold leases on their version. Updates
and removal must respect those leases instead of replacing executables under a running agent.

## Setup must not happen as a health-check side effect

Opening a provider session can start MCP servers, run hooks, or launch a login browser.
[Grok probes](../../apps/server/src/provider/Layers/GrokProvider.ts) avoid authentication and
session creation for this reason. Antigravity likewise reserves authenticated catalog sessions for
explicit setup or model refresh; background checks use initialization only.

[Antigravity sign-in](../../apps/server/src/provider/AntigravityAuth.ts) belongs to the initiating
T3 auth session. The client carries the return URL back to the environment because the provider's
loopback listener may be on another machine. Forward only the callback for the owned pending flow;
a successful callback HTTP request is not proof that provider authentication finished. The native
process owns token exchange and storage.

Antigravity sign-out closes admission to new processes and stops existing processes before clearing account
metadata. Otherwise a helper or resumed session could retain the old account. Cached model lists
do not establish current access, and an authoritative empty catalog must clear the old list.

Antigravity text-generation helpers deny tool requests, but native hooks and MCP configuration can
run before the prompt. They reject profiles with such configuration before launch. Prompt
instructions and tool denial do not create a native sandbox.
See [helper constraints](../../apps/server/src/textGeneration/AntigravityTextGeneration.ts).

## Provider updates run only through the owning installer

A one-click update is offered only when the resolved executable's path proves which installer owns
it. Homebrew and npm are proven by the real path (symlinks followed): a versioned keg or cask under
`brew --prefix`, or `<prefix>/lib/node_modules/<pkg>/` (Windows: the shim beside `node_modules`).
Native installer layouts and the global bin directories of pnpm, Bun, and Vite+ may match on either
the resolved path or its real target, since those installers place real files or their own symlinks
there. Anything unproven stays manual-only but still reports the version gap. npm updates pin
`--prefix` because the `npm` on `PATH` can belong to a different Node than the one that owns the
provider. Homebrew
compares against `brew info` since casks trail npm by hours; native installs share npm's version
train, so the registry stays authoritative for them.
See the [resolver](../../apps/server/src/provider/providerMaintenance.ts).

Ownership is cached per instance and re-read immediately before an update runs. The
[runner](../../apps/server/src/provider/providerMaintenanceRunner.ts) refuses when the lock key
changed since the advisory, and reports success only when the refreshed provider is still installed
with a readable, current version.

## Cline speaks ACP, and its ACP build is narrower than the CLI

[Cline](https://cline.bot) is integrated over `cline --acp` — newline-delimited JSON-RPC 2.0 on
stdio. Three properties of that build shape the whole integration, and each is a place a future
maintainer will otherwise get wrong:

**Authentication is never requested.** Cline's ACP `authenticate` starts a device-code OAuth
flow: it writes a URL to stderr, tries to open a browser, and then blocks until someone finishes
it. On a T3 server that browser opens on a machine the user is not sitting at, and the request
never returns. The runtime therefore leaves `authMethodId` unset for Cline and reads
authentication out of the session-setup answer instead.

Do not assume the guard is always a well-formed response, even though that is the verified shape.
Against Cline 3.0.65 an unauthenticated CLI answers `session/new` with
`-32000 {"message":"Authentication required: Call authenticate before starting a session"}`, and
that is the path the live probe exercises. A build that gives up earlier yields no request error at
all: it can print the guard to stderr and exit, which surfaces as an `AcpProcessExitedError`, or
fail so early that only a thrown defect carries text. The classifier reads all three, and is
deliberately narrow about each: `-32000` is a generic ACP code, so the method and the message wording
must both line up, and anything that reads like a startup failure (`spawn`, `ENOENT`, `not found`)
stays a broken install even when it mentions the API key.
See [Cline ACP support](../../apps/server/src/provider/acp/ClineAcpSupport.ts).

**The model option cannot be found by category.** Cline advertises its provider picker with
`category: "model"` and lists it _before_ the model picker, so the shared "first model-category
option" lookup resolves to `provider` and `session/set_config_option` would change the account
instead of the model. Cline resolves its own option id. The same call rejects a selection outside
the advertised catalog, because `session/set_model` accepts any string on this build.

**Tool approval has exactly one knob.** Cline exposes a single `auto_approve` boolean: no per-tool
policies, nothing between "ask about everything" and "approve everything". T3 therefore accepts only
`Supervised` and `Full access`, and implements the difference in its own permission handler rather
than by writing that boolean: Supervised asks the user through the normal approval event, and Full
access answers each request with Cline's own accept option. Cline does not remember a previous
"allow always", so Full access re-approves every request instead of pretending the CLI learned the
answer. The two in-between T3 modes are declared unsupported on the snapshot rather than silently
widened. See [Cline provider](../../apps/server/src/provider/Layers/ClineProvider.ts).

Three more limits are declared the same way instead of being discovered at send time. Cline
advertises `promptCapabilities.image: true` and then discards every non-text block before
dispatch, so the snapshot reports no image support and the adapter refuses attachments. It binds
its mode on the _first_ prompt, so a mid-thread switch to Plan would still allow file edits;
Plan is therefore unsupported and the interaction-mode toggle is hidden. And it hard-disables
reasoning, so no thinking level is offered.

Cline stores the ACP `mcpServers` field and never loads those servers, so the adapter declares
`consumesMcpServers: false` and the server does not mint an MCP credential for the session.
Configure MCP on the Cline side instead. Background text generation is withheld the same way:
titles, branch names and commit messages go to another provider.

## Protocol traps

Codex async questions arrive as notifications and are answered with a new user message. There is
no pending RPC response to send. Blocking questions still use the request/response path. The
[adapter](../../apps/server/src/provider/Layers/CodexAdapter.ts) distinguishes them; the
[decider](../../apps/server/src/orchestration/decider.ts) records an async answer and its user
message together.

An async question can outlive the turn or a server restart. The engine reads that request's
durable activity before resolving it because the in-memory command snapshot omits old activities.
Do not infer that a request has disappeared merely because it is outside the recent window.

Capabilities must describe what the provider can actually do. Antigravity can capture workspace
checkpoints but cannot roll back its conversation. The [checkpoint boundary](./overview.md#turn-completion-and-checkpoints)
therefore rejects revert before touching files. Native permission and question option IDs must
also survive normalization; a display label is not necessarily a valid reply.

## Attachments and stored history

Attachments live outside the project workspace. [ProviderService](../../apps/server/src/provider/Layers/ProviderService.ts)
puts their environment-local paths in turn input and lets adapters choose native input formats.
A path in the prompt does not grant filesystem access. Keep provider sandbox and approval rules
in force; copying uploads into the project to bypass them changes that boundary.

File attachments introduced a replay compatibility limit. Image-only clients cannot decode
file-bearing messages, and an image-only server can fail the entire environment's startup when
replaying one such event. Rollouts and downgrades must account for persisted history as well as
current client support.

Model classification has its own [manifest constraints](./model-manifest.md). Assistant-reference
handling is documented under [citations](./assistant-citations.md).
