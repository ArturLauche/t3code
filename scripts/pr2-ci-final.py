from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one match in {path}, found {count}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1))


replace_once(
    "apps/desktop/src/ipc/methods/sshEnvironment.ts",
    '''    yield* withLoopbackSshApi(
      "register-github-environment",
      (resolvedHttpBaseUrl) =>
        Effect.gen(function* () {
          const descriptor = yield* fetchRemoteEnvironmentDescriptor({
            httpBaseUrl: resolvedHttpBaseUrl,
          });
          yield* github.registerTrustedEnvironment({
            environmentId: descriptor.environmentId,
            httpBaseUrl: resolvedHttpBaseUrl,
            accessToken: access.access_token,
          });
        }),
    )(httpBaseUrl).pipe(
      Effect.catch(() =>
        Effect.logWarning("Could not register the optional GitHub credential bridge for SSH.", {
          reason: "registration-failed",
        }),
      ),
    );''',
    '''    yield* Effect.gen(function* () {
      const resolvedHttpBaseUrl = yield* resolveLoopbackSshHttpBaseUrl(httpBaseUrl);
      const descriptor = yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: resolvedHttpBaseUrl,
      });
      yield* github.registerTrustedEnvironment({
        environmentId: descriptor.environmentId,
        httpBaseUrl: resolvedHttpBaseUrl,
        accessToken: access.access_token,
      });
    }).pipe(
      Effect.tapError(() =>
        Effect.logWarning("Could not register the optional GitHub credential bridge for SSH.", {
          reason: "registration-failed",
        }),
      ),
      Effect.ignore,
    );''',
)

replace_once(
    "apps/desktop/src/sandbox/DesktopCloudSandboxEnvironment.ts",
    '''interface DaytonaTransport {
  readonly target: DesktopSshEnvironmentTarget;
  readonly access: SandboxSshAccess;
}''',
    '''interface DaytonaTransport {
  readonly target: DesktopSshEnvironmentTarget;
  readonly access: SandboxSshAccess;
}

interface DaytonaTransportDecision {
  readonly winner: DaytonaTransport;
  readonly loser: DaytonaTransport | null;
  readonly stale: DaytonaTransport | null;
}''',
)
replace_once(
    "apps/desktop/src/sandbox/DesktopCloudSandboxEnvironment.ts",
    '''      const decision = yield* Ref.modify(daytonaTransports, (current) => {
        const existing = current.get(key);
        if (existing && isUsable(existing, compareAt)) {
          return [{ winner: existing, loser: candidate, stale: null }, current] as const;
        }
        const next = new Map(current);
        next.set(key, candidate);
        return [{ winner: candidate, loser: null, stale: existing ?? null }, next] as const;
      });''',
    '''      const decision = yield* Ref.modify(
        daytonaTransports,
        (
          current,
        ): readonly [DaytonaTransportDecision, Map<string, DaytonaTransport>] => {
          const existing = current.get(key);
          if (existing && isUsable(existing, compareAt)) {
            return [{ winner: existing, loser: candidate, stale: null }, current];
          }
          const next = new Map(current);
          next.set(key, candidate);
          return [{ winner: candidate, loser: null, stale: existing ?? null }, next];
        },
      );''',
)
replace_once(
    "apps/desktop/src/sandbox/DesktopCloudSandboxEnvironment.ts",
    '''    const bootstrap = yield* ssh
      .ensureEnvironment(transport.target, { issuePairingToken: input.issuePairingToken })
      .pipe(
        Effect.mapError((cause) =>
          operationError("bootstrap-ssh", cause, "daytona", transport!.access.token),
        ),
      );''',
    '''    const selectedTransport = transport;
    const bootstrap = yield* ssh
      .ensureEnvironment(selectedTransport.target, { issuePairingToken: input.issuePairingToken })
      .pipe(
        Effect.mapError((cause) =>
          operationError("bootstrap-ssh", cause, "daytona", selectedTransport.access.token),
        ),
      );''',
)
