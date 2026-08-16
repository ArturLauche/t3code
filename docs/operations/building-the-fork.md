# Building the Fork with GitHub Actions

This fork is independently buildable on standard GitHub-hosted runners. You do
not need access to upstream T3 Code's Blacksmith runners, Clerk, Cloudflare,
Apple signing, or Azure Trusted Signing configuration.

## Quick start

1. Fork the repository.
2. Enable Actions in your fork.
3. Run **Actions → Build Fork → Run workflow** (or push to `main`).

Artifacts for Windows, Linux, and macOS are uploaded to the workflow run.

## Workflows

### `.github/workflows/build-fork.yml`

Standard GitHub-hosted runners (`windows-latest`, `ubuntu-latest`,
`macos-latest`, `macos-13`). Triggers:

- `workflow_dispatch` (manual)
- `push` to `main` (when app/packages/native/scripts change)

Builds at least:

| Platform | Runner | Artifact |
| --- | --- | --- |
| Windows x64 NSIS | `windows-latest` | `*.exe` |
| Linux x64 AppImage | `ubuntu-latest` | `*.AppImage` |
| macOS arm64 | `macos-latest` | `*.dmg` |
| macOS x64 | `macos-13` | `*.dmg` |

It reuses the existing desktop build scripts (`build:desktop`,
`dist:desktop:artifact` with `--platform/--target/--arch`).

### Signing

Signing is **optional**. If signing secrets are not configured, the workflow
still produces unsigned artifacts. Configure these secrets later to enable
signing:

- `FORK_DESKTOP_SIGNED=true`
- `APPLE_TEAM_ID`, `MACOS_PROVISIONING_PROFILE`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD` (macOS notarization)
- `AZURE_TRUSTED_SIGNING_*` (Windows Azure Trusted Signing)

### Cloud / relay config

The fork does **not** require upstream T3 Code production Clerk or Cloudflare
configuration. These are optional:

- `T3CODE_CLERK_PUBLISHABLE_KEY`, `T3CODE_CLERK_JWT_TEMPLATE`,
  `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`
- `T3CODE_RELAY_URL`

When absent, the desktop app builds and runs as a local/self-hosted
application.

### Releases (tags)

Pushing a tag like `v1.2.3` triggers the `release` job, which downloads all
desktop artifacts and creates/updates a GitHub Release with the installers
attached. `softprops/action-gh-release` generates release notes automatically.

## Ordinary CI

`.github/workflows/ci.yml` runs type checking, tests, linting, resource monitor
checks, and the desktop build smoke test. Upstream-only `blacksmith-*` runners
are replaced with standard GitHub-hosted runners when Blacksmith is unavailable,
preserving all useful upstream CI logic.

## Updater feed

The desktop updater defaults to **this fork's own repository**
(`GITHUB_REPOSITORY`) via `resolveGitHubPublishConfig` in
`scripts/build-desktop-artifact.ts`. Installations built from this fork update
from this fork's releases rather than accidentally updating back to upstream
T3 Code. Override with `T3CODE_DESKTOP_UPDATE_REPOSITORY` if you host your own
release feed.

## Building locally

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build:desktop
pnpm run dist:desktop:artifact -- --platform linux --target AppImage --arch x64
```
