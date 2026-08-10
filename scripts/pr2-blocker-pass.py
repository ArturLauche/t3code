from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one match in {path}, found {count}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1))


# Daytona: a losing concurrent grant has the same host alias as the winning grant.
# Revoke only the losing grant; disconnect only a stale transport that was actually established.
replace_once(
    "apps/desktop/src/sandbox/DesktopCloudSandboxEnvironment.ts",
    '''    const cleanupTransport = (transport: DaytonaTransport) =>
      ssh.disconnectEnvironment(transport.target).pipe(
        Effect.ignore,
        Effect.andThen(Effect.tryPromise(() => transport.access.revoke()).pipe(Effect.ignore)),
      );''',
    '''    const cleanupTransport = (transport: DaytonaTransport) =>
      ssh.disconnectEnvironment(transport.target).pipe(
        Effect.ignore,
        Effect.andThen(Effect.tryPromise(() => transport.access.revoke()).pipe(Effect.ignore)),
      );
    const revokeAccess = (transport: DaytonaTransport) =>
      Effect.tryPromise(() => transport.access.revoke()).pipe(Effect.ignore);''',
)
replace_once(
    "apps/desktop/src/sandbox/DesktopCloudSandboxEnvironment.ts",
    '''      if (decision.loser) yield* cleanupTransport(decision.loser);
      if (decision.stale) yield* cleanupTransport(decision.stale);''',
    '''      if (decision.loser) yield* revokeAccess(decision.loser);
      if (decision.stale) yield* cleanupTransport(decision.stale);''',
)

# VcsProcess: scope the GitHub lease over the entire command preparation/execution so interruption
# between acquisition and spawn cannot strand the token file.
vcs = Path("apps/server/src/vcs/VcsProcess.ts")
text = vcs.read_text()
old_open = '''  const run = Effect.fn("VcsProcess.run")(function* (input: VcsProcessInput) {
    const githubLease =
      Option.isSome(githubBroker) && input.command === "git"
        ? yield* githubBroker.value.gitProcessEnvironment.pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not prepare ephemeral GitHub credentials.", {
                operation: error.operation,
              }).pipe(Effect.as(Option.none<GitHubCredentialBroker.GitHubGitEnvironmentLease>())),
            ),
          )
        : Option.none<GitHubCredentialBroker.GitHubGitEnvironmentLease>();'''
new_open = '''  const run = Effect.fn("VcsProcess.run")((input: VcsProcessInput) =>
    Effect.scoped(
      Effect.gen(function* () {
        const githubLease =
          Option.isSome(githubBroker) && input.command === "git"
            ? yield* Effect.acquireRelease(
                githubBroker.value.gitProcessEnvironment.pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("Could not prepare ephemeral GitHub credentials.", {
                      operation: error.operation,
                    }).pipe(
                      Effect.as(Option.none<GitHubCredentialBroker.GitHubGitEnvironmentLease>()),
                    ),
                  ),
                ),
                (lease) => (Option.isSome(lease) ? lease.value.release : Effect.void),
              )
            : Option.none<GitHubCredentialBroker.GitHubGitEnvironmentLease>();'''
if text.count(old_open) != 1:
    raise RuntimeError(f"VcsProcess open block count was {text.count(old_open)}")
text = text.replace(old_open, new_open, 1)
text = text.replace(
    '''      .pipe(
        Option.isSome(githubLease) ? Effect.ensuring(githubLease.value.release) : (effect) => effect,
        Effect.mapError(''',
    '''      .pipe(
        Effect.mapError(''',
    1,
)
old_close = '''    return {
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    } satisfies VcsProcessOutput;
  });'''
new_close = '''        return {
          exitCode: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
        } satisfies VcsProcessOutput;
      }),
    ),
  );'''
if text.count(old_close) != 1:
    raise RuntimeError(f"VcsProcess close block count was {text.count(old_close)}")
text = text.replace(old_close, new_close, 1)
vcs.write_text(text)

# Device flow: invalidate old asynchronous start continuations on clear/supersession.
replace_once(
    "packages/github/src/deviceFlow.ts",
    '''  private starting: Promise<GitHubDeviceFlowAuthorization> | null = null;
  private lastError: unknown | null = null;''',
    '''  private starting: Promise<GitHubDeviceFlowAuthorization> | null = null;
  private lastError: unknown | null = null;
  private generation = 0;''',
)
replace_once(
    "packages/github/src/deviceFlow.ts",
    '''    this.pending = null;
    this.lastError = null;
    let verificationReceived = false;''',
    '''    this.pending = null;
    this.lastError = null;
    const generation = ++this.generation;
    let verificationReceived = false;''',
)
replace_once(
    "packages/github/src/deviceFlow.ts",
    '''    const starting = verification.promise.then((value) => {
      const authorization = {''',
    '''    const starting = verification.promise.then((value) => {
      if (generation !== this.generation) {
        throw new Error("GitHub device authorization was cancelled.");
      }
      const authorization = {''',
)
replace_once(
    "packages/github/src/deviceFlow.ts",
    '''      () => {
        if (this.starting === starting) this.starting = null;
      },
      (error: unknown) => {
        if (this.starting === starting) this.starting = null;
        this.lastError = error;
      },''',
    '''      () => {
        if (generation === this.generation && this.starting === starting) this.starting = null;
      },
      (error: unknown) => {
        if (generation !== this.generation) return;
        if (this.starting === starting) this.starting = null;
        this.lastError = error;
      },''',
)
replace_once(
    "packages/github/src/deviceFlow.ts",
    '''  clear(): void {
    this.pending = null;
    this.starting = null;
    this.lastError = null;
  }''',
    '''  clear(): void {
    this.generation += 1;
    this.pending = null;
    this.starting = null;
    this.lastError = null;
  }''',
)

# Novita follows the E2B security model; secure controller access is the safe SDK default.
replace_once(
    "packages/sandbox/src/adapters/novita.ts",
    '''    timeoutMs,
    secure: false,
    metadata: {''',
    '''    timeoutMs,
    metadata: {''',
)

# Readiness must reject HTTP error responses consistently instead of accepting a provider 5xx proxy.
replace_once(
    "packages/sandbox/src/bootstrap.ts",
    '''curl --silent --max-time 1 -o /dev/null''',
    '''curl --silent --fail --max-time 1 -o /dev/null''',
)

# Validate the raw timeout exactly; parseInt silently truncates values such as "3.5".
replace_once(
    "apps/web/src/components/settings/CloudSandboxesSettings.tsx",
    '''    const timeout = Number.parseInt(timeoutMinutes, 10);''',
    '''    const timeout = Number(timeoutMinutes);''',
)

# Record the deliberate caller-over-broker environment precedence that protects unattended fetches.
replace_once(
    "apps/server/src/sourceControl/GitHubCredentialBroker.ts",
    '''  const hooksPath = brokerEnvironment[BROKER_HOOKS_PATH_KEY];
  const merged = { ...brokerEnvironment, ...baseEnvironment };''',
    '''  const hooksPath = brokerEnvironment[BROKER_HOOKS_PATH_KEY];
  // Caller values intentionally win: unattended fetches pass GIT_ASKPASS="" and
  // must be able to suppress broker credential prompting.
  const merged = { ...brokerEnvironment, ...baseEnvironment };''',
)
