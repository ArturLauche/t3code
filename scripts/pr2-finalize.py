from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one match in {path}, found {count}: {old[:80]!r}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "packages/contracts/src/ipc.ts",
    '''export const DesktopGitHubCredentialSyncInputSchema = Schema.Struct({
  httpBaseUrl: Schema.String,
  environmentAccessToken: Schema.String,
});''',
    '''export const DesktopGitHubCredentialSyncInputSchema = Schema.Struct({
  environmentId: EnvironmentId,
});''',
)

replace_once(
    "apps/web/src/connection/platform.ts",
    '''    const sourceControlCredentials = SourceControlCredentialGateway.of({
      sync: Effect.fn("web.connectionPlatform.sourceControl.syncCredential")(
        function* (connection) {
          const bridge = window.desktopBridge;
          if (bridge === undefined) return;
          const environmentAccessToken =
            connection.httpAuthorization?._tag === "Bearer"
              ? connection.httpAuthorization.token
              : connection.target._tag === "PrimaryConnectionTarget"
                ? yield* Effect.tryPromise({
                    try: () => bridge.getLocalEnvironmentBearerToken(),
                    catch: cloudSandboxPreparationError,
                  })
                : null;
          if (environmentAccessToken === null) return;
          yield* Effect.tryPromise({
            try: () =>
              bridge.syncGitHubCredential({
                httpBaseUrl: connection.httpBaseUrl,
                environmentAccessToken,
              }),
            catch: (cause) =>
              new ConnectionTransientError({
                reason: "remote-unavailable",
                detail: `Could not synchronize the GitHub credential: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          });
        },
      ),
    });''',
    '''    const sourceControlCredentials = SourceControlCredentialGateway.of({
      sync: Effect.fn("web.connectionPlatform.sourceControl.syncCredential")(
        function* (connection) {
          const bridge = window.desktopBridge;
          if (bridge === undefined) return;
          if (
            connection.target._tag === "RelayConnectionTarget" ||
            connection.target._tag === "BearerConnectionTarget"
          ) {
            return;
          }
          if (connection.target._tag === "PrimaryConnectionTarget") {
            yield* Effect.tryPromise({
              try: () => bridge.getLocalEnvironmentBearerToken(),
              catch: (cause) =>
                new ConnectionTransientError({
                  reason: "remote-unavailable",
                  detail: `Could not register the local environment for GitHub credential sync: ${cause instanceof Error ? cause.message : String(cause)}`,
                }),
            });
          }
          yield* Effect.tryPromise({
            try: () =>
              bridge.syncGitHubCredential({
                environmentId: connection.target.environmentId,
              }),
            catch: (cause) =>
              new ConnectionTransientError({
                reason: "remote-unavailable",
                detail: `Could not synchronize the GitHub credential: ${cause instanceof Error ? cause.message : String(cause)}`,
              }),
          });
        },
      ),
    });''',
)

replace_once(
    "packages/client-runtime/src/connection/resolver.ts",
    '''    if (Option.isSome(sourceControlCredentials)) {
      yield* sourceControlCredentials.value.sync(prepared);
    }
    return prepared;''',
    '''    if (Option.isSome(sourceControlCredentials)) {
      yield* sourceControlCredentials.value.sync(prepared).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not synchronize optional source-control credentials.", {
            cause,
            environmentId: prepared.target.environmentId,
          }),
        ),
      );
    }
    return prepared;''',
)

replace_once(
    "apps/server/src/vcs/GitVcsDriverCore.ts",
    '''              env: {
                ...process.env,
                ...input.env,
                ...(Option.isSome(githubEnvironment) ? githubEnvironment.value : {}),
                ...trace2Monitor.env,
              },''',
    '''              env: {
                ...process.env,
                ...(Option.isSome(githubEnvironment) ? githubEnvironment.value : {}),
                ...input.env,
                ...trace2Monitor.env,
              },''',
)

replace_once(
    "scripts/release-smoke.ts",
    '''  "packages/contracts/package.json",
  "packages/shared/package.json",''',
    '''  "packages/contracts/package.json",
  "packages/github/package.json",
  "packages/sandbox/package.json",
  "packages/shared/package.json",''',
)

replace_once(
    "packages/ssh/src/command.ts",
    '''function redactSshCommandForLogs(
  target: DesktopSshEnvironmentTarget,
  command: readonly string[],
): string[] {''',
    '''export function redactSshCommandForLogs(
  target: DesktopSshEnvironmentTarget,
  command: readonly string[],
): string[] {''',
)
replace_once(
    "packages/ssh/src/command.ts",
    '''  const logCommand = redactSshCommandForLogs(target, [sshCommand, ...args]);''',
    '''  const logCommand = redactSshCommandForLogs(target, [sshCommand, ...args]);
  const logHostSpec = redactSshCommandForLogs(target, [hostSpec])[0] ?? "[ssh-target]";''',
)
replace_once(
    "packages/ssh/src/command.ts",
    '''                : `Failed to spawn SSH command for ${hostSpec}.`,''',
    '''                : `Failed to spawn SSH command for ${logHostSpec}.`,''',
)
replace_once(
    "packages/ssh/src/command.ts",
    '''          command: ["ssh", ...args],
          exitCode: null,
          stderr: "",
          message:
            cause instanceof Error ? cause.message : `Failed to run SSH command for ${hostSpec}.`,''',
    '''          command: logCommand,
          exitCode: null,
          stderr: "",
          message:
            cause instanceof Error ? cause.message : `Failed to run SSH command for ${logHostSpec}.`,''',
)
replace_once(
    "packages/ssh/src/command.ts",
    '''  if (exitCode !== 0) {
    const diagnosticStdout = redactSshErrorOutput(stdout);
    yield* Effect.logWarning("ssh.command.failed", {
      ...sshTargetLogFields(target),
      command: ["ssh", ...args],
      exitCode,
      stdout: diagnosticStdout,
      stderr,
    });
    return yield* new SshCommandError({
      command: ["ssh", ...args],
      exitCode,
      stdout: diagnosticStdout,
      stderr,
      message: normalizeSshErrorMessage({
        stdout: diagnosticStdout,
        stderr,
        fallbackMessage: `SSH command failed for ${hostSpec} (exit ${exitCode}).`,
      }),
    });
  }

  yield* Effect.logDebug("ssh.command.succeeded", {
    ...sshTargetLogFields(target),
    command: ["ssh", ...args],
  });''',
    '''  if (exitCode !== 0) {
    const diagnosticStdout = redactSshErrorOutput(stdout);
    const diagnosticStderr = redactSshErrorOutput(stderr);
    yield* Effect.logWarning("ssh.command.failed", {
      ...sshTargetLogFields(target),
      command: logCommand,
      exitCode,
      stdout: diagnosticStdout,
      stderr: diagnosticStderr,
    });
    return yield* new SshCommandError({
      command: logCommand,
      exitCode,
      stdout: diagnosticStdout,
      stderr: diagnosticStderr,
      message: normalizeSshErrorMessage({
        stdout: diagnosticStdout,
        stderr: diagnosticStderr,
        fallbackMessage: `SSH command failed for ${logHostSpec} (exit ${exitCode}).`,
      }),
    });
  }

  yield* Effect.logDebug("ssh.command.succeeded", {
    ...sshTargetLogFields(target),
    command: logCommand,
  });''',
)

replace_once(
    "packages/ssh/src/tunnel.ts",
    '''  remoteStateKey,
  resolveSshCommand,
  resolveSshTarget,''',
    '''  remoteStateKey,
  redactSshCommandForLogs,
  resolveSshCommand,
  resolveSshTarget,''',
)
replace_once(
    "packages/ssh/src/tunnel.ts",
    '''function redactSshCommandForLogs(
  target: DesktopSshEnvironmentTarget,
  command: readonly string[],
): string[] {
  if (!usesEphemeralUsernameCredential(target) || target.username === null) {
    return [...command];
  }
  return command.map((part) => part.replaceAll(target.username!, "[redacted-ssh-credential]"));
}

''',
    "",
)

replace_once(
    "apps/desktop/src/ipc/methods/window.ts",
    '''} from "@t3tools/contracts";
import * as NodeOS from "node:os";''',
    '''} from "@t3tools/contracts";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import * as NodeOS from "node:os";''',
)
replace_once(
    "apps/desktop/src/ipc/methods/window.ts",
    '''import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";''',
    '''import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopGitHubIntegration from "../../github/DesktopGitHubIntegration.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";''',
)
replace_once(
    "apps/desktop/src/ipc/methods/window.ts",
    '''  handler: Effect.fn("desktop.ipc.window.getLocalEnvironmentBearerToken")(function* () {
    const localAuth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
    return yield* localAuth.getBearerToken;
  }),''',
    '''  handler: Effect.fn("desktop.ipc.window.getLocalEnvironmentBearerToken")(function* () {
    const localAuth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
    const token = yield* localAuth.getBearerToken;
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const github = yield* Effect.serviceOption(DesktopGitHubIntegration.DesktopGitHubIntegration);
    if (Option.isSome(github)) {
      const primary = yield* pool.primary;
      const config = Option.getOrNull(yield* primary.currentConfig);
      if (config !== null) {
        const descriptor = yield* fetchRemoteEnvironmentDescriptor({
          httpBaseUrl: config.httpBaseUrl.href,
        }).pipe(Effect.option);
        if (Option.isSome(descriptor)) {
          yield* github.value.registerTrustedEnvironment({
            environmentId: descriptor.value.environmentId,
            httpBaseUrl: config.httpBaseUrl.href,
            accessToken: token,
          });
        }
      }
    }
    return token;
  }),''',
)

build = Path(".github/workflows/build-fork.yml")
text = build.read_text()
text = text.replace("actions/checkout@v6", "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803")
text = text.replace("voidzero-dev/setup-vp@v1", "voidzero-dev/setup-vp@250f29ce396baf5e8f24498e17c0dfdebabc26eb")
text = text.replace("actions/upload-artifact@v7", "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a")
text = text.replace("actions/download-artifact@v8", "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c")
text = text.replace("dtolnay/rust-toolchain@stable", "dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c")
text = text.replace(
    "      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803\n\n",
    "      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803\n        with:\n          persist-credentials: false\n\n",
)
text = text.replace(
    "      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803\n        with:\n          fetch-depth: 0",
    "      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803\n        with:\n          persist-credentials: false\n          fetch-depth: 0",
)
text = text.replace(
    '''          echo "value=$version" >> "$GITHUB_OUTPUT"''',
    '''          if [[ ! "$version" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
            echo "Invalid release version: $version" >&2
            exit 1
          fi
          echo "value=$version" >> "$GITHUB_OUTPUT"''',
)
text = text.replace(
    '''          AZURE_TRUSTED_SIGNING_PUBLISHER_NAME: ${{ secrets.AZURE_TRUSTED_SIGNING_PUBLISHER_NAME }}
        run: |''',
    '''          AZURE_TRUSTED_SIGNING_PUBLISHER_NAME: ${{ secrets.AZURE_TRUSTED_SIGNING_PUBLISHER_NAME }}
          ARTIFACT_VERSION: ${{ steps.version.outputs.value }}
        run: |''',
    1,
)
text = text.replace('''            --build-version "${{ steps.version.outputs.value }}"''', '''            --build-version "$ARTIFACT_VERSION"''')
text = text.replace(
    "    if: always() && startsWith(github.ref, 'refs/tags/v')",
    "    if: ${{ !cancelled() && needs.build.result == 'success' && startsWith(github.ref, 'refs/tags/v') }}",
)
build.write_text(text)

ci = Path(".github/workflows/ci.yml")
ci.write_text(ci.read_text().replace("timeout-minutes: 10", "timeout-minutes: 20"))
