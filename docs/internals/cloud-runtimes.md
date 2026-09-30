# Cloud runtimes

A cloud runtime is a sandbox vendor (E2B, Novita, Daytona) T3 Code drives so a
provider CLI can run somewhere other than the host. The pieces live in
[`apps/server/src/cloud/runtime`](../../apps/server/src/cloud/runtime).

Three rules are easy to get wrong, and each has cost money or leaked a credential
when it did.

## Ownership comes from vendor metadata, never from the request

Every sandbox T3 creates is stamped with `t3ManagedExecution`, the runtime id and
the environment id, and the server reads those back before listing, pausing,
deleting, executing in or starting a process on it
([sandboxOwnership.ts](../../apps/server/src/cloud/runtime/sandboxOwnership.ts)). A
sandbox id from a client is a request, not proof: two T3 environments can
legitimately share one vendor account, and without the environment id in the
comparison one of them could drive the other's sandbox.

The same rule decides whether a turn may run on an existing sandbox. Only
`running` and `paused` qualify. `unknown` — the state assigned to a vendor state
string this build does not recognise — does not, so a future vendor state fails
closed into creating a fresh sandbox instead of reusing a machine nobody verified.

## `enabled` gates execution, not ownership

Disabling a runtime means "do not run turns here". It does not mean "forget the
account": its sandboxes keep billing, and pausing or deleting them is the only way
to stop that. Listing and lifecycle actions therefore stay available on a
disabled runtime, while execution, sandbox creation and testing do not
([CloudRuntimeServiceLive.ts](../../apps/server/src/cloud/runtime/CloudRuntimeServiceLive.ts)).
Making `requireConfig` reject a disabled runtime for every operation is what
created the "stranded paid sandbox" state.

## A credential is scoped to one vendor account at one endpoint

Changing a runtime's vendor, API domain, custom endpoint or region points it at a
different destination, so the stored key is deleted on that transition —
including through a hand edit of `settings.json`, which does not go through the
update transaction ([credentialName.ts](../../apps/server/src/cloud/runtime/credentialName.ts)).
A removal the secret store refuses stays pending and is retried before the next
settings write, because a key that outlives its configuration would be reused if
the same id were added again.

The sandboxes created under the old identity go with it. They are retired by
[CloudSandboxRetirement.ts](../../apps/server/src/cloud/runtime/CloudSandboxRetirement.ts),
which watches for exactly that transition and uses the credential that still owns
them — the moment after the settings layer has invalidated it, they are
unreachable and still billing.

## Lifecycle boundaries

A vendor client outlives the spawn call that created it, so `startProcess` owns
closing it and hands that to a fiber waiting on the process. Anything that fails
or is interrupted first closes it on the way out.

Cleanup runs on a non-success exit, not only on a typed failure: an abandoned
request has already created a paid sandbox, and so has an interrupted
preparation. A sandbox a preparation only _borrowed_ is never deleted on failure —
it belongs to the next turn.

Stopping a process escalates. A provider CLI that ignores SIGTERM is killed
outright, because a release that returns while the vendor keeps billing is worse
than a slower shutdown.
