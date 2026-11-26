# OpenCode

Run OpenCode **1.14.19+** or **OpenCode 2.0.18+** in T3 Code. Install and authenticate OpenCode on the server machine, then enable it in **Settings → Providers** (see [provider setup](./install.md#providers)).

## OpenCode 1.x vs. 2.x

T3 Code detects your installed version automatically. OpenCode 1.x has **Limited support**.

- OpenCode 2 ships as a separate package (`@opencode/cli`, e.g. `npm install -g @opencode/cli`). T3 Code's update button upgrades your installed package without switching 1.x to 2.x.
- Do not run 1.x and 2.x side by side on the same machine—OpenCode 2 converts the shared database on first run. Existing 1.x threads continue on 2.x.

## Local or external server

- **Managed local server** (default): Leave **Server URL** empty. Uses your configured password, `OPENCODE_SERVER_PASSWORD`, or a generated password.
- **External server**: Set **Server URL** and password in provider settings (does not forward local `OPENCODE_SERVER_PASSWORD`).
- **Updating a local service**: When **Server URL** points to a local OpenCode background service (using its exact host/port—`127.0.0.1` for `0.0.0.0`, `[::1]` for `[::]`, not `localhost`), T3 Code upgrades the CLI and restarts the service (interrupting active turns; configure service env vars with `opencode service set env <name> <value>`). Other external servers must be restarted manually.

## Compaction, approvals, and catalog refresh

- **Compaction**: Send `/compact` manually, or configure `compaction` (`auto`, `buffer`, `keep.tokens`) in `opencode.json` on OpenCode 2.
- **Approvals**: Follows [permission modes](./permission-modes.md); **Auto** behaves like **Supervised**. Reading `.env` / `.env.local` asks for approval in restricted modes (`.env.example` is allowed). **Allow for workspace** applies across all OpenCode sessions sharing that workspace—use **Allow once** on shared servers.
- **Refreshing config**: Click **Refresh provider status** (web/desktop) or **Refresh models** (mobile) after auth/config changes. Local helper caches clear after 30 seconds of inactivity; external servers may need a restart. Project-specific models in `opencode.json` load when opening that project's model picker.

T3 Code does not restart a server reached through `localhost`, including this
machine's OpenCode background service. That server can keep reporting the
previous version until you restart it; for a loopback URL, T3 Code shows the
restart requirement instead of treating the CLI update as a failure.

T3 Code waits for a local server it started to recover after a lost connection.
You can stop the turn while it reconnects. If the server exits or an external
connection cannot be restored, send another prompt to resume the same OpenCode
session.

## Add providers and models

**Settings > Providers** has a **Providers** section for each OpenCode instance.
It lists the providers OpenCode reported as _Available through OpenCode_, and
anything you add under _Configured in T3 Code_.

Use it to point OpenCode at a relay or self-hosted endpoint, give a provider a
package to load, and declare models OpenCode does not know yet. Entries become
OpenCode's own configuration, so OpenCode resolves them; a model appears in the
model picker once OpenCode reports it as connected. Until then the model row
reads _not connected yet_, and the provider card names any configured model that
did not connect — usually a wrong key or base URL.

A model id alone is enough when the provider already serves it. Set the display
name and the reasoning, image, or tool switches only when you want to override
what OpenCode infers. OpenCode needs a context window and a maximum output size
together, so fill in both or leave both blank.

API keys are stored separately from settings and are never sent back to the app.
**Environment** on the same card is the place for values OpenCode should read
from the environment instead, including `OPENCODE_CONFIG_CONTENT` if you keep a
hand-written OpenCode configuration: T3 Code merges its own providers into it
rather than replacing it.

These entries only apply to an OpenCode server T3 Code starts. A configured
**Server URL** keeps its own configuration, so change it there.
