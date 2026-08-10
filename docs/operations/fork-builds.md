# Building a fork with GitHub Actions

`.github/workflows/build-fork.yml` is the standalone desktop build/release workflow for forks. It uses
only standard GitHub-hosted runners and does not require upstream Blacksmith, Clerk, Cloudflare, Apple,
Azure, or deployment secrets.

## Build artifacts

Run **Build Fork** from the Actions tab, push to `main`, or push a `vX.Y.Z` tag. The matrix builds and
uploads:

- Windows x64 NSIS on `windows-latest`;
- Linux x64 AppImage on `ubuntu-latest`;
- macOS arm64 DMG/ZIP on `macos-15`; and
- macOS x64 DMG/ZIP on `macos-15-intel`.

It calls the existing `dist:desktop:artifact` implementation, including the resource monitor and the
Linux node-pty prebuild used by the packaged Windows WSL backend. Every successful platform job uploads
its installer, blockmaps, and updater metadata as an Actions artifact.

For a `vX.Y.Z` tag, the workflow creates or updates that GitHub Release and uploads all artifacts from
successful matrix jobs. The upstream `.github/workflows/release.yml` is gated to the upstream
`pingdotgg/t3code` repository, so it cannot request upstream production infrastructure in a fork.

## Optional public configuration

- `T3CODE_GITHUB_CLIENT_ID` repository variable: your GitHub OAuth app client ID with Device Flow
  enabled. If omitted, users can connect with a fine-grained PAT or existing `gh` authentication.
- Clerk and T3 Connect relay configuration are intentionally absent. An ordinary fork build remains a
  functional local/self-hosted desktop and does not point at upstream private infrastructure.

## Optional signing

With no signing secrets, the workflow explicitly produces unsigned packages. To enable signing later,
configure the complete platform set used by the existing packaging script:

- macOS: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`,
  `MACOS_PROVISIONING_PROFILE`, and the `APPLE_TEAM_ID` repository variable. Signed passkey builds also
  use the `CLERK_PASSKEY_RP_DOMAINS` variable.
- Windows Azure Trusted Signing: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
  `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
  `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, and
  `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`.

A partial secret set is treated as unsigned. A complete set opts that platform into the existing
signing/notarization path.

## Updater ownership

The workflow sets `T3CODE_DESKTOP_UPDATE_REPOSITORY` to `${{ github.repository }}` at build time.
Installations made by the fork therefore read update metadata from that fork's releases and cannot
silently update to upstream T3 Code. Local builds outside GitHub Actions have no feed unless
`T3CODE_DESKTOP_UPDATE_REPOSITORY=owner/repo` (or `GITHUB_REPOSITORY`) is provided; the UI reports that
automatic updates are unavailable in that case.

## Local validation

From the repository root:

```bash
vp install
vp check
vp run typecheck
vp run test
vp run test:resource-monitor
vp run dist:desktop:linux
```

Use the platform-specific `dist:desktop:win:x64`, `dist:desktop:dmg:arm64`, or
`dist:desktop:dmg:x64` script on the matching host. Output defaults to `release/`.
