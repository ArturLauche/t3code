from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one match in {path}, found {count}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1))


# Git credential broker: make token files process-scoped and append Git hardening
# without clobbering caller GIT_CONFIG_* entries.
replace_once(
    "apps/server/src/sourceControl/GitHubCredentialBroker.ts",
    '''interface EphemeralCredential {
  readonly token: string;
  readonly expiresAtEpochMs: number;
}
''',
    '''interface EphemeralCredential {
  readonly token: string;
  readonly expiresAtEpochMs: number;
}

export interface GitHubGitEnvironmentLease {
  readonly environment: NodeJS.ProcessEnv;
  readonly release: Effect.Effect<void>;
}

const BROKER_HOOKS_PATH_KEY = "T3_GITHUB_HOOKS_PATH";

export function mergeGitHubGitEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  brokerEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const hooksPath = brokerEnvironment[BROKER_HOOKS_PATH_KEY];
  const merged = { ...brokerEnvironment, ...baseEnvironment };
  delete merged[BROKER_HOOKS_PATH_KEY];
  if (!hooksPath) return merged;

  const parsedCount = Number.parseInt(merged.GIT_CONFIG_COUNT ?? "0", 10);
  const count = Number.isSafeInteger(parsedCount) && parsedCount >= 0 ? parsedCount : 0;
  merged.GIT_CONFIG_COUNT = String(count + 1);
  merged[`GIT_CONFIG_KEY_${count}`] = "core.hooksPath";
  merged[`GIT_CONFIG_VALUE_${count}`] = hooksPath;
  return merged;
}
''',
)
replace_once(
    "apps/server/src/sourceControl/GitHubCredentialBroker.ts",
    '''    readonly processEnvironment: Effect.Effect<
      Option.Option<NodeJS.ProcessEnv>,
      GitHubCredentialBrokerError
    >;''',
    '''    readonly gitProcessEnvironment: Effect.Effect<
      Option.Option<GitHubGitEnvironmentLease>,
      GitHubCredentialBrokerError
    >;''',
)
replace_once(
    "apps/server/src/sourceControl/GitHubCredentialBroker.ts",
    '''  const ephemeral = yield* Ref.make(new Map<string, EphemeralCredential>());
  const helperDir = path.join(config.stateDir, "credential-helpers");''',
    '''  const ephemeral = yield* Ref.make(new Map<string, EphemeralCredential>());
  const tokenFiles = yield* Ref.make(new Map<string, ReadonlySet<string>>());
  const helperDir = path.join(config.stateDir, "credential-helpers");''',
)
replace_once(
    "apps/server/src/sourceControl/GitHubCredentialBroker.ts",
    '''  const currentSessionId = Effect.serviceOption(EnvironmentAuthenticatedPrincipal).pipe(
    Effect.map(Option.map((principal) => String(principal.sessionId))),
  );

  const getTokenForSession = (sessionId: Option.Option<string>) =>''',
    '''  const currentSessionId = Effect.serviceOption(EnvironmentAuthenticatedPrincipal).pipe(
    Effect.map(Option.map((principal) => String(principal.sessionId))),
  );
  const credentialKey = (sessionId: Option.Option<string>) =>
    Option.match(sessionId, {
      onNone: () => "persistent",
      onSome: (value) => `session:${value}`,
    });
  const cleanupTokenFiles = (key: string) =>
    Ref.modify(tokenFiles, (current) => {
      const files = [...(current.get(key) ?? [])];
      const next = new Map(current);
      next.delete(key);
      return [files, next] as const;
    }).pipe(
      Effect.flatMap((files) =>
        Effect.forEach(files, (file) => fileSystem.remove(file, { force: true }).pipe(Effect.ignore), {
          discard: true,
        }),
      ),
    );

  const getTokenForSession = (sessionId: Option.Option<string>) =>''',
)
replace_once(
    "apps/server/src/sourceControl/GitHubCredentialBroker.ts",
    '''          yield* Ref.update(ephemeral, (entries) => {
            const next = new Map(entries);
            next.delete(sessionId.value);
            return next;
          });
        }
      }''',
    '''          yield* Ref.update(ephemeral, (entries) => {
            const next = new Map(entries);
            next.delete(sessionId.value);
            return next;
          });
          yield* cleanupTokenFiles(credentialKey(sessionId));
        }
      }''',
)
start = '''  const tokenFileFor = (sessionId: Option.Option<string>) => {
    const key = Option.getOrElse(sessionId, () => "persistent");
    const digest = NodeCrypto.createHash("sha256").update(key).digest("hex");
    return path.join(tokenDir, `${digest}.token`);
  };

  const gitHardeningEnvironment = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: emptyHooksDir,
  } satisfies NodeJS.ProcessEnv;

  const processEnvironment = Effect.gen(function* () {
    const sessionId = yield* currentSessionId;
    const token = yield* getTokenForSession(sessionId);
    if (Option.isNone(token)) return Option.none<NodeJS.ProcessEnv>();
    const tokenFile = tokenFileFor(sessionId);
    yield* fileSystem
      .writeFileString(tokenFile, token.value)
      .pipe(Effect.mapError((cause) => error("write-token-file", cause)));
    yield* fileSystem
      .chmod(tokenFile, 0o600)
      .pipe(Effect.mapError((cause) => error("protect-token-file", cause)));
    return Option.some<NodeJS.ProcessEnv>({
      ...gitHardeningEnvironment,
      GIT_ASKPASS: platform === "win32" ? windowsScriptPath : posixScriptPath,
      GIT_ASKPASS_REQUIRE: "force",
      GIT_TERMINAL_PROMPT: "0",
      T3_GITHUB_NODE_EXECUTABLE: process.execPath,
      T3_GITHUB_ASKPASS_SCRIPT: scriptPath,
      T3_GITHUB_TOKEN_FILE: tokenFile,
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    });
  });'''
end = '''  const tokenFileFor = (key: string) => {
    const digest = NodeCrypto.createHash("sha256").update(key).digest("hex");
    return path.join(tokenDir, `${digest}-${NodeCrypto.randomUUID()}.token`);
  };

  const gitProcessEnvironment = Effect.gen(function* () {
    const sessionId = yield* currentSessionId;
    const token = yield* getTokenForSession(sessionId);
    if (Option.isNone(token)) return Option.none<GitHubGitEnvironmentLease>();
    const key = credentialKey(sessionId);
    const tokenFile = tokenFileFor(key);
    yield* fileSystem
      .writeFileString(tokenFile, token.value)
      .pipe(Effect.mapError((cause) => error("write-token-file", cause)));
    yield* fileSystem
      .chmod(tokenFile, 0o600)
      .pipe(Effect.mapError((cause) => error("protect-token-file", cause)));
    yield* Ref.update(tokenFiles, (current) => {
      const next = new Map(current);
      next.set(key, new Set([...(current.get(key) ?? []), tokenFile]));
      return next;
    });
    const release = fileSystem.remove(tokenFile, { force: true }).pipe(
      Effect.ignore,
      Effect.andThen(
        Ref.update(tokenFiles, (current) => {
          const remaining = new Set(current.get(key) ?? []);
          remaining.delete(tokenFile);
          const next = new Map(current);
          if (remaining.size === 0) next.delete(key);
          else next.set(key, remaining);
          return next;
        }),
      ),
    );
    return Option.some<GitHubGitEnvironmentLease>({
      environment: {
        [BROKER_HOOKS_PATH_KEY]: emptyHooksDir,
        GIT_ASKPASS: platform === "win32" ? windowsScriptPath : posixScriptPath,
        GIT_ASKPASS_REQUIRE: "force",
        GIT_TERMINAL_PROMPT: "0",
        T3_GITHUB_NODE_EXECUTABLE: process.execPath,
        T3_GITHUB_ASKPASS_SCRIPT: scriptPath,
        T3_GITHUB_TOKEN_FILE: tokenFile,
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
      release,
    });
  });'''
replace_once("apps/server/src/sourceControl/GitHubCredentialBroker.ts", start, end)
replace_once(
    "apps/server/src/sourceControl/GitHubCredentialBroker.ts",
    '''    clearEphemeral: (sessionId) =>
      Ref.update(ephemeral, (entries) => {
        const next = new Map(entries);
        next.delete(sessionId);
        return next;
      }).pipe(
        Effect.andThen(fileSystem.remove(tokenFileFor(Option.some(sessionId))).pipe(Effect.ignore)),
      ),''',
    '''    clearEphemeral: (sessionId) =>
      Ref.update(ephemeral, (entries) => {
        const next = new Map(entries);
        next.delete(sessionId);
        return next;
      }).pipe(Effect.andThen(cleanupTokenFiles(credentialKey(Option.some(sessionId))))),''',
)
replace_once(
    "apps/server/src/sourceControl/GitHubCredentialBroker.ts",
    '''    clearPersistentToken: secrets.remove(PERSISTED_GITHUB_TOKEN).pipe(
      Effect.mapError((cause) => error("clear-token", cause)),
      Effect.andThen(fileSystem.remove(tokenFileFor(Option.none())).pipe(Effect.ignore)),
    ),
    processEnvironment,
    cliEnvironment: getToken.pipe(
      Effect.map(
        Option.map((token) => ({
          ...gitHardeningEnvironment,
          GH_TOKEN: token,
        })),
      ),
    ),''',
    '''    clearPersistentToken: secrets.remove(PERSISTED_GITHUB_TOKEN).pipe(
      Effect.mapError((cause) => error("clear-token", cause)),
      Effect.andThen(cleanupTokenFiles(credentialKey(Option.none()))),
    ),
    gitProcessEnvironment,
    cliEnvironment: getToken.pipe(
      Effect.map(Option.map((token) => ({ GH_TOKEN: token }))),
    ),''',
)

# Broker tests exercise per-process cleanup and existing Git config preservation.
replace_once(
    "apps/server/src/sourceControl/GitHubCredentialBroker.test.ts",
    '''    const environment = Option.getOrThrow(
      yield* broker.processEnvironment.pipe(
        Effect.provideService(EnvironmentAuthenticatedPrincipal, principal("session-a")),
      ),
    );

    assert.isUndefined(environment.GH_TOKEN);''',
    '''    const lease = Option.getOrThrow(
      yield* broker.gitProcessEnvironment.pipe(
        Effect.provideService(EnvironmentAuthenticatedPrincipal, principal("session-a")),
      ),
    );
    const environment = GitHubCredentialBroker.mergeGitHubGitEnvironment(
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "store",
      },
      lease.environment,
    );

    assert.isUndefined(environment.GH_TOKEN);''',
)
replace_once(
    "apps/server/src/sourceControl/GitHubCredentialBroker.test.ts",
    '''    assert.strictEqual(environment.GIT_CONFIG_KEY_0, "core.hooksPath");
    const wrapper = yield* fileSystem.readFileString(environment.GIT_ASKPASS!);''',
    '''    assert.strictEqual(environment.GIT_CONFIG_COUNT, "2");
    assert.strictEqual(environment.GIT_CONFIG_KEY_0, "credential.helper");
    assert.strictEqual(environment.GIT_CONFIG_KEY_1, "core.hooksPath");
    const tokenFile = environment.T3_GITHUB_TOKEN_FILE!;
    const wrapper = yield* fileSystem.readFileString(environment.GIT_ASKPASS!);''',
)
replace_once(
    "apps/server/src/sourceControl/GitHubCredentialBroker.test.ts",
    '''    assert.include(helper, 'remote.protocol !== "https:"');
  }).pipe(Effect.provide(brokerLayer)),''',
    '''    assert.include(helper, 'remote.protocol !== "https:"');
    yield* lease.release;
    assert.isFalse(yield* fileSystem.exists(tokenFile));
  }).pipe(Effect.provide(brokerLayer)),''',
)

# Apply broker leases around Git child processes; explicit caller env still wins.
replace_once(
    "apps/server/src/vcs/VcsProcess.ts",
    '''    const githubEnvironment =
      Option.isSome(githubBroker) && (input.command === "git" || input.command === "gh")
        ? yield* (input.command === "gh"
            ? githubBroker.value.cliEnvironment
            : githubBroker.value.processEnvironment
          ).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not prepare ephemeral GitHub credentials.", {
                operation: error.operation,
              }).pipe(Effect.as(Option.none<NodeJS.ProcessEnv>())),
            ),
          )
        : Option.none<NodeJS.ProcessEnv>();''',
    '''    const githubLease =
      Option.isSome(githubBroker) && input.command === "git"
        ? yield* githubBroker.value.gitProcessEnvironment.pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not prepare ephemeral GitHub credentials.", {
                operation: error.operation,
              }).pipe(Effect.as(Option.none<GitHubCredentialBroker.GitHubGitEnvironmentLease>())),
            ),
          )
        : Option.none<GitHubCredentialBroker.GitHubGitEnvironmentLease>();
    const githubCliEnvironment =
      Option.isSome(githubBroker) && input.command === "gh"
        ? yield* githubBroker.value.cliEnvironment.pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not prepare GitHub CLI credentials.", {
                operation: error.operation,
              }).pipe(Effect.as(Option.none<NodeJS.ProcessEnv>())),
            ),
          )
        : Option.none<NodeJS.ProcessEnv>();
    const baseEnvironment = { ...process.env, ...input.env };
    const processEnvironment = Option.isSome(githubLease)
      ? GitHubCredentialBroker.mergeGitHubGitEnvironment(
          baseEnvironment,
          githubLease.value.environment,
        )
      : {
          ...process.env,
          ...(Option.isSome(githubCliEnvironment) ? githubCliEnvironment.value : {}),
          ...input.env,
        };''',
)
replace_once(
    "apps/server/src/vcs/VcsProcess.ts",
    '''        env: {
          ...process.env,
          ...(Option.isSome(githubEnvironment) ? githubEnvironment.value : {}),
          ...input.env,
        },''',
    '''        env: processEnvironment,''',
)
replace_once(
    "apps/server/src/vcs/VcsProcess.ts",
    '''      .pipe(
        Effect.mapError(''',
    '''      .pipe(
        Option.isSome(githubLease) ? Effect.ensuring(githubLease.value.release) : (effect) => effect,
        Effect.mapError(''',
)

replace_once(
    "apps/server/src/vcs/GitVcsDriverCore.ts",
    '''          const githubEnvironment = Option.isSome(githubBroker)
            ? yield* githubBroker.value.processEnvironment.pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Could not prepare ephemeral GitHub credentials.", {
                    operation: error.operation,
                  }).pipe(Effect.as(Option.none<NodeJS.ProcessEnv>())),
                ),
              )
            : Option.none<NodeJS.ProcessEnv>();''',
    '''          const githubLease = Option.isSome(githubBroker)
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
            : Option.none<GitHubCredentialBroker.GitHubGitEnvironmentLease>();''',
)
replace_once(
    "apps/server/src/vcs/GitVcsDriverCore.ts",
    '''              env: {
                ...process.env,
                ...(Option.isSome(githubEnvironment) ? githubEnvironment.value : {}),
                ...input.env,
                ...trace2Monitor.env,
              },''',
    '''              env: Option.isSome(githubLease)
                ? GitHubCredentialBroker.mergeGitHubGitEnvironment(
                    { ...process.env, ...input.env, ...trace2Monitor.env },
                    githubLease.value.environment,
                  )
                : { ...process.env, ...input.env, ...trace2Monitor.env },''',
)

# Remove the unused remote expiresAt contract field instead of silently ignoring it.
replace_once(
    "packages/contracts/src/github.ts",
    '''export const GitHubCredentialInjectionInput = Schema.Struct({
  token: TrimmedNonEmptyString,
  expiresAt: Schema.optionalKey(Schema.String),
  ttlSeconds: Schema.optionalKey(NonNegativeInt),
});''',
    '''export const GitHubCredentialInjectionInput = Schema.Struct({
  token: TrimmedNonEmptyString,
  ttlSeconds: Schema.optionalKey(NonNegativeInt),
});''',
)
replace_once(
    "apps/desktop/src/github/DesktopGitHubIntegration.ts",
    '''      readonly token: string;
      readonly expiresAt: string | null;
    }) {''',
    '''      readonly token: string;
    }) {''',
)
replace_once(
    "apps/desktop/src/github/DesktopGitHubIntegration.ts",
    '''        HttpClientRequest.bodyJsonUnsafe({
          token: input.token,
          ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
          ttlSeconds: REMOTE_CREDENTIAL_TTL_SECONDS,
        }),''',
    '''        HttpClientRequest.bodyJsonUnsafe({
          token: input.token,
          ttlSeconds: REMOTE_CREDENTIAL_TTL_SECONDS,
        }),''',
)
text = Path("apps/desktop/src/github/DesktopGitHubIntegration.ts").read_text()
text = text.replace('''          token: credential.value.token,
          expiresAt: credential.value.expiresAt,
''', '''          token: credential.value.token,
''')
Path("apps/desktop/src/github/DesktopGitHubIntegration.ts").write_text(text)

# Daytona transport cache: expiry-aware and race-safe. Provider listing becomes recoverable.
replace_once(
    "apps/desktop/src/sandbox/DesktopCloudSandboxEnvironment.ts",
    '''import * as Context from "effect/Context";
import * as Effect from "effect/Effect";''',
    '''import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";''',
)
replace_once(
    "apps/desktop/src/sandbox/DesktopCloudSandboxEnvironment.ts",
    '''    readonly listProviderConnections: Effect.Effect<readonly CloudSandboxProviderConnection[]>;''',
    '''    readonly listProviderConnections: Effect.Effect<
      readonly CloudSandboxProviderConnection[],
      ExecutionEnvironmentOperationError
    >;''',
)
old = '''    const key = `${input.sandbox.providerConnectionId}:${input.sandbox.sandboxId}`;
    const active = (yield* Ref.get(daytonaTransports)).get(key);
    let transport = active;
    if (!transport) {
      const access = yield* callProvider({
        provider: "daytona",
        operation: "create-ssh-access",
        secret: input.secret,
        action: () => input.adapter.createSshAccess!(input.sandbox.sandboxId, 60),
      });
      transport = {
        access,
        target: {
          alias: access.hostname,
          hostname: access.hostname,
          username: access.username,
          port: access.port,
        },
      };
      yield* Ref.update(daytonaTransports, (current) => new Map(current).set(key, transport!));
    }
    const bootstrap = yield* ssh
      .ensureEnvironment(transport.target, { issuePairingToken: input.issuePairingToken })'''
new = '''    const key = `${input.sandbox.providerConnectionId}:${input.sandbox.sandboxId}`;
    const isUsable = (transport: DaytonaTransport, now: number) => {
      const expiresAt = Date.parse(transport.access.expiresAt);
      return Number.isFinite(expiresAt) && expiresAt > now + 30_000;
    };
    const cleanupTransport = (transport: DaytonaTransport) =>
      ssh.disconnectEnvironment(transport.target).pipe(
        Effect.ignore,
        Effect.andThen(Effect.tryPromise(() => transport.access.revoke()).pipe(Effect.ignore)),
      );
    const now = yield* Clock.currentTimeMillis;
    const active = (yield* Ref.get(daytonaTransports)).get(key);
    let transport = active && isUsable(active, now) ? active : undefined;
    if (!transport) {
      const access = yield* callProvider({
        provider: "daytona",
        operation: "create-ssh-access",
        secret: input.secret,
        action: () => input.adapter.createSshAccess!(input.sandbox.sandboxId, 60),
      });
      const candidate: DaytonaTransport = {
        access,
        target: {
          alias: access.hostname,
          hostname: access.hostname,
          username: access.username,
          port: access.port,
        },
      };
      const compareAt = yield* Clock.currentTimeMillis;
      const decision = yield* Ref.modify(daytonaTransports, (current) => {
        const existing = current.get(key);
        if (existing && isUsable(existing, compareAt)) {
          return [{ winner: existing, loser: candidate, stale: null }, current] as const;
        }
        const next = new Map(current);
        next.set(key, candidate);
        return [{ winner: candidate, loser: null, stale: existing ?? null }, next] as const;
      });
      if (decision.loser) yield* cleanupTransport(decision.loser);
      if (decision.stale) yield* cleanupTransport(decision.stale);
      transport = decision.winner;
    }
    const bootstrap = yield* ssh
      .ensureEnvironment(transport.target, { issuePairingToken: input.issuePairingToken })'''
replace_once("apps/desktop/src/sandbox/DesktopCloudSandboxEnvironment.ts", old, new)
replace_once(
    "apps/desktop/src/sandbox/DesktopCloudSandboxEnvironment.ts",
    '''    const current = yield* Ref.get(daytonaTransports);
    const transport = current.get(key);
    if (!transport) return;
    yield* ssh.disconnectEnvironment(transport.target).pipe(Effect.ignore);
    yield* Effect.tryPromise(() => transport.access.revoke()).pipe(Effect.ignore);
    yield* Ref.update(daytonaTransports, (entries) => {
      const next = new Map(entries);
      next.delete(key);
      return next;
    });''',
    '''    const transport = yield* Ref.modify(daytonaTransports, (entries) => {
      const selected = entries.get(key);
      const next = new Map(entries);
      next.delete(key);
      return [selected, next] as const;
    });
    if (!transport) return;
    yield* ssh.disconnectEnvironment(transport.target).pipe(Effect.ignore);
    yield* Effect.tryPromise(() => transport.access.revoke()).pipe(Effect.ignore);''',
)
replace_once(
    "apps/desktop/src/sandbox/DesktopCloudSandboxEnvironment.ts",
    '''    const current = yield* Ref.get(daytonaTransports);
    yield* Effect.forEach(''',
    '''    const current = yield* Ref.getAndSet(daytonaTransports, new Map());
    yield* Effect.forEach(''',
)
replace_once(
    "apps/desktop/src/sandbox/DesktopCloudSandboxEnvironment.ts",
    '''    );
    yield* Ref.set(daytonaTransports, new Map());
  });''',
    '''    );
  });''',
)
replace_once(
    "apps/desktop/src/sandbox/DesktopCloudSandboxEnvironment.ts",
    '''    listProviderConnections: store.listProviderConnections.pipe(Effect.orDie),''',
    '''    listProviderConnections: store.listProviderConnections.pipe(
      Effect.mapError((cause) => operationError("list-providers", cause)),
    ),''',
)
replace_once(
    "apps/desktop/src/sandbox/DesktopCloudSandboxEnvironment.ts",
    '''          Effect.gen(function* () {
            const { stored, adapter } = yield* resolveProvider(connection.id);
            const records = yield* callProvider({
              provider: connection.provider,
              operation: "list",
              secret: stored.apiKey,
              action: adapter.list,
            });
            return yield* Effect.forEach(records, withAssociation);
          }),''',
    '''          Effect.gen(function* () {
            const { stored, adapter } = yield* resolveProvider(connection.id);
            const records = yield* callProvider({
              provider: connection.provider,
              operation: "list",
              secret: stored.apiKey,
              action: adapter.list,
            });
            return yield* Effect.forEach(records, withAssociation);
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not list sandboxes for provider connection.", {
                providerConnectionId: connection.id,
                provider: connection.provider,
                detail: cause.detail,
              }).pipe(Effect.as<readonly CloudSandboxRecord[]>([])),
            ),
          ),''',
)
replace_once(
    "apps/desktop/src/sandbox/DesktopCloudSandboxEnvironment.ts",
    '''          yield* store.setAssociation({ ...input, project: null }).pipe(Effect.ignore);''',
    '''          yield* store
            .setAssociation({
              providerConnectionId: input.providerConnectionId,
              sandboxId: input.sandboxId,
              project: null,
            })
            .pipe(Effect.ignore);''',
)

# Settings: disconnect catalog entries before provider-destructive actions and never trap Cancel.
replace_once(
    "apps/web/src/components/settings/CloudSandboxesSettings.tsx",
    '''  const connect = useAtomCommand(connectCloudSandbox, { reportFailure: false });
  const { environments } = useEnvironments();''',
    '''  const connect = useAtomCommand(connectCloudSandbox, { reportFailure: false });
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const { environments } = useEnvironments();''',
)
replace_once(
    "apps/web/src/components/settings/CloudSandboxesSettings.tsx",
    '''import { connectCloudSandbox } from "../../connection/onboarding";''',
    '''import { environmentCatalog } from "../../connection/catalog";
import { connectCloudSandbox } from "../../connection/onboarding";''',
)
text = Path("apps/web/src/components/settings/CloudSandboxesSettings.tsx").read_text()
text = text.replace('''<DialogClose render={<Button variant="outline" disabled={pending} />}>Cancel</DialogClose>''', '''<DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>''')
Path("apps/web/src/components/settings/CloudSandboxesSettings.tsx").write_text(text)
replace_once(
    "apps/web/src/components/settings/CloudSandboxesSettings.tsx",
    '''      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>''',
    '''      setError(errorMessage(cause));
      await onSaved().catch(() => undefined);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>''',
)
replace_once(
    "apps/web/src/components/settings/CloudSandboxesSettings.tsx",
    '''    const parsedCpu = Number.parseFloat(cpu);''',
    '''    if (!Number.isInteger(timeout) || timeout <= 0) {
      setError("Automatic timeout must be a positive whole number of minutes.");
      return;
    }
    const parsedCpu = Number.parseFloat(cpu);''',
)
replace_once(
    "apps/web/src/components/settings/CloudSandboxesSettings.tsx",
    '''  const runLifecycle = async (sandbox: CloudSandboxRecord, action: CloudSandboxLifecycleAction) => {
    if (!bridge) return;
    const key = `${sandbox.providerConnectionId}:${sandbox.sandboxId}:${action}`;
    setPendingKey(key);
    try {
      await bridge.runCloudSandboxLifecycleAction({''',
    '''  const removeRegisteredSandboxEnvironments = async (
    predicate: (sandbox: { providerConnectionId: string; sandboxId: string }) => boolean,
  ) => {
    for (const environment of environments) {
      const profile = Option.getOrNull(environment.entry.profile);
      if (profile?._tag !== "CloudSandboxConnectionProfile" || !predicate(profile.target)) continue;
      const result = await removeEnvironment(environment.environmentId);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        throw squashAtomCommandFailure(result);
      }
    }
  };

  const runLifecycle = async (sandbox: CloudSandboxRecord, action: CloudSandboxLifecycleAction) => {
    if (!bridge) return;
    const key = `${sandbox.providerConnectionId}:${sandbox.sandboxId}:${action}`;
    setPendingKey(key);
    try {
      if (action === "pause" || action === "stop" || action === "delete") {
        await removeRegisteredSandboxEnvironments(
          (target) =>
            target.providerConnectionId === sandbox.providerConnectionId &&
            target.sandboxId === sandbox.sandboxId,
        );
      }
      await bridge.runCloudSandboxLifecycleAction({''',
)
replace_once(
    "apps/web/src/components/settings/CloudSandboxesSettings.tsx",
    '''    try {
      await bridge.removeCloudSandboxProviderConnection({ id: connection.id });''',
    '''    try {
      await removeRegisteredSandboxEnvironments(
        (target) => target.providerConnectionId === connection.id,
      );
      await bridge.removeCloudSandboxProviderConnection({ id: connection.id });''',
)

# Always leave cloud catalog entries removable from generic Connections settings.
replace_once(
    "apps/web/src/components/settings/ConnectionsSettings.tsx",
    '''        .filter(
          (environment) =>
            environment.entry.target._tag !== "PrimaryConnectionTarget" &&
            environment.entry.target._tag !== "CloudSandboxConnectionTarget",
        )''',
    '''        .filter(
          (environment) => environment.entry.target._tag !== "PrimaryConnectionTarget",
        )''',
)

# GitHub settings polling: self-contained cancellable loop, clamped intervals, handled disconnect.
github_settings = Path("apps/web/src/components/settings/GitHubConnectionSettings.tsx")
text = github_settings.read_text()
text = text.replace('''  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);''', '''  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollGeneration = useRef(0);''')
old = '''  const poll = useCallback(async () => {
    if (!bridge || !authorization) return;
    try {
      const next = await bridge.pollGitHubDeviceAuthorization();
      setStatus(next);
      if (next.state === "authorizing") {
        pollTimer.current = setTimeout(
          () => void poll(),
          Math.max(authorization.intervalSeconds, 2) * 1_000,
        );
      } else {
        setAuthorization(null);
        setPending(false);
      }
    } catch (cause) {
      setPending(false);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not connect GitHub",
          description: message(cause),
        }),
      );
    }
  }, [authorization, bridge]);

  useEffect(() => {
    if (authorization && pending) {
      pollTimer.current = setTimeout(() => void poll(), authorization.intervalSeconds * 1_000);
    }
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [authorization, pending, poll]);'''
new = '''  useEffect(() => {
    if (!bridge || !authorization || !pending) return;
    const generation = ++pollGeneration.current;
    let cancelled = false;
    const runPoll = async () => {
      try {
        const next = await bridge.pollGitHubDeviceAuthorization();
        if (cancelled || generation !== pollGeneration.current) return;
        setStatus(next);
        if (next.state === "authorizing") {
          pollTimer.current = setTimeout(
            () => void runPoll(),
            Math.max(authorization.intervalSeconds, 2) * 1_000,
          );
        } else {
          setAuthorization(null);
          setPending(false);
        }
      } catch (cause) {
        if (cancelled || generation !== pollGeneration.current) return;
        setAuthorization(null);
        setPending(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not connect GitHub",
            description: message(cause),
          }),
        );
      }
    };
    pollTimer.current = setTimeout(
      () => void runPoll(),
      Math.max(authorization.intervalSeconds, 2) * 1_000,
    );
    return () => {
      cancelled = true;
      pollGeneration.current += 1;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [authorization, bridge, pending]);'''
if text.count(old) != 1:
    raise RuntimeError("GitHub polling block mismatch")
text = text.replace(old, new, 1)
text = text.replace(
    '''  const disconnect = async () => {
    await bridge.disconnectGitHub();
    setAuthorization(null);
    await refresh();
  };''',
    '''  const disconnect = async () => {
    setPending(true);
    try {
      await bridge.disconnectGitHub();
      setAuthorization(null);
      await refresh();
    } catch (cause) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not disconnect GitHub",
          description: message(cause),
        }),
      );
    } finally {
      setPending(false);
    }
  };''',
    1,
)
github_settings.write_text(text)

# Command Palette: central GitHub only on trusted desktop-managed targets, ref-guard ephemeral create,
# and use the environmentId-only sync contract before a central private clone.
replace_once(
    "apps/web/src/components/CommandPalette.tsx",
    '''  const composerHandleRef = useRef<ChatComposerHandle | null>(null);''',
    '''  const composerHandleRef = useRef<ChatComposerHandle | null>(null);
  const ephemeralSandboxCreationRef = useRef(false);''',
)
replace_once(
    "apps/web/src/components/CommandPalette.tsx",
    '''      if (!bridge || isCreatingEphemeralSandbox) return;
      setIsCreatingEphemeralSandbox(true);''',
    '''      if (!bridge || ephemeralSandboxCreationRef.current) return;
      ephemeralSandboxCreationRef.current = true;
      setIsCreatingEphemeralSandbox(true);''',
)
replace_once(
    "apps/web/src/components/CommandPalette.tsx",
    '''      } finally {
        setIsCreatingEphemeralSandbox(false);
      }
    },
    [
      buildAddProjectSourceGroups,
      connectSandboxEnvironment,
      githubConnection?.state,
      isCreatingEphemeralSandbox,
      pushPaletteView,
    ],''',
    '''      } finally {
        ephemeralSandboxCreationRef.current = false;
        setIsCreatingEphemeralSandbox(false);
      }
    },
    [
      buildAddProjectSourceGroups,
      connectSandboxEnvironment,
      githubConnection?.state,
      pushPaletteView,
    ],''',
)
replace_once(
    "apps/web/src/components/CommandPalette.tsx",
    '''      pushPaletteView({
        addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
        groups: buildAddProjectSourceGroups(
          environmentId,
          buildAddProjectRemoteSourceReadiness(
            browseEnvironmentId === environmentId ? sourceControlDiscovery.data : null,
            githubConnection?.state === "connected",
          ),
        ),
      });''',
    '''      const centralGitHubAvailable =
        githubConnection?.state === "connected" &&
        environment.entry.target._tag !== "RelayConnectionTarget" &&
        environment.entry.target._tag !== "BearerConnectionTarget";
      pushPaletteView({
        addonIcon: <FolderPlusIcon className={ADDON_ICON_CLASS} />,
        groups: buildAddProjectSourceGroups(
          environmentId,
          buildAddProjectRemoteSourceReadiness(
            browseEnvironmentId === environmentId ? sourceControlDiscovery.data : null,
            centralGitHubAvailable,
          ),
        ),
      });''',
)
replace_once(
    "apps/web/src/components/CommandPalette.tsx",
    '''          buildAddProjectRemoteSourceReadiness(
            sourceControlDiscovery.data,
            githubConnection?.state === "connected",
          ),''',
    '''          buildAddProjectRemoteSourceReadiness(
            sourceControlDiscovery.data,
            githubConnection?.state === "connected" &&
              browseEnvironment?.entry.target._tag !== "RelayConnectionTarget" &&
              browseEnvironment?.entry.target._tag !== "BearerConnectionTarget",
          ),''',
)
old = '''    if (
      addProjectCloneFlow.source === "github" &&
      githubConnection?.state === "connected" &&
      window.desktopBridge &&
      Option.isSome(browsePreparedConnection)
    ) {
      try {
        const prepared = browsePreparedConnection.value;
        const environmentAccessToken =
          prepared.httpAuthorization?._tag === "Bearer"
            ? prepared.httpAuthorization.token
            : prepared.target._tag === "PrimaryConnectionTarget"
              ? await window.desktopBridge.getLocalEnvironmentBearerToken()
              : null;
        if (environmentAccessToken === null) {
          throw new Error("The selected environment did not provide a credential bridge.");
        }
        await window.desktopBridge.syncGitHubCredential({
          httpBaseUrl: prepared.httpBaseUrl,
          environmentAccessToken,
        });
      } catch (cause) {
        setIsRemoteProjectCloning(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "GitHub credential unavailable",
            description: errorMessage(cause),
          }),
        );
        return;
      }
    }'''
new = '''    if (addProjectCloneFlow.source === "github" && githubConnection?.state === "connected") {
      try {
        const bridge = window.desktopBridge;
        if (!bridge || Option.isNone(browsePreparedConnection)) {
          throw new Error("The selected environment is not ready for GitHub credential sync.");
        }
        const prepared = browsePreparedConnection.value;
        if (
          prepared.target._tag === "RelayConnectionTarget" ||
          prepared.target._tag === "BearerConnectionTarget"
        ) {
          throw new Error("Central GitHub credentials are not available for this connection type.");
        }
        if (prepared.target._tag === "PrimaryConnectionTarget") {
          await bridge.getLocalEnvironmentBearerToken();
        }
        const synchronized = await bridge.syncGitHubCredential({
          environmentId: prepared.target.environmentId,
        });
        if (!synchronized) {
          throw new Error("The selected environment did not register a trusted credential target.");
        }
      } catch (cause) {
        setIsRemoteProjectCloning(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "GitHub credential unavailable",
            description: errorMessage(cause),
          }),
        );
        return;
      }
    }'''
replace_once("apps/web/src/components/CommandPalette.tsx", old, new)

# E2B/Novita paused sandboxes can resume after their previous endAt by using the duration recorded at creation.
for path in ["packages/sandbox/src/adapters/e2b.ts", "packages/sandbox/src/adapters/novita.ts"]:
    replace_once(
        path,
        '''      "t3-ephemeral": input.ephemeral ? "true" : "false",
    },''',
        '''      "t3-ephemeral": input.ephemeral ? "true" : "false",
      "t3-timeout-ms": String(timeoutMs),
    },''',
    ) if path.endswith("e2b.ts") else None

# Novita declares timeoutMs inline; hoist it so metadata records the intended duration.
replace_once(
    "packages/sandbox/src/adapters/novita.ts",
    '''  const timeoutAction = input.ephemeral ? "delete" : (input.timeoutAction ?? "pause");
  return {
    ...options(credential),
    timeoutMs: (input.timeoutMinutes ?? 60) * 60_000,''',
    '''  const timeoutAction = input.ephemeral ? "delete" : (input.timeoutAction ?? "pause");
  const timeoutMs = (input.timeoutMinutes ?? 60) * 60_000;
  return {
    ...options(credential),
    timeoutMs,''',
)
replace_once(
    "packages/sandbox/src/adapters/novita.ts",
    '''      "t3-ephemeral": input.ephemeral ? "true" : "false",
    },''',
    '''      "t3-ephemeral": input.ephemeral ? "true" : "false",
      "t3-timeout-ms": String(timeoutMs),
    },''',
)
for path in ["packages/sandbox/src/adapters/e2b.ts", "packages/sandbox/src/adapters/novita.ts"]:
    replace_once(
        path,
        '''    if (!Number.isFinite(remaining) || remaining <= 0) {
      throw new Error(`Sandbox ${sandboxId} has reached its configured timeout.`);
    }
    return Math.max(1, Math.floor(remaining));''',
        '''    if (Number.isFinite(remaining) && remaining > 0) {
      return Math.max(1, Math.floor(remaining));
    }
    const configuredTimeoutMs = Number(info.metadata["t3-timeout-ms"]);
    if (info.state === "paused" && Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0) {
      return Math.floor(configuredTimeoutMs);
    }
    throw new Error(`Sandbox ${sandboxId} has reached its configured timeout.`);''',
    )

# The sandbox bootstrap health probe must not assume a bare `node` binary is on PATH.
replace_once(
    "packages/sandbox/src/bootstrap.ts",
    '''  if node -e 'const http=require("node:http");const p=Number(process.argv[1]);const r=http.get({host:"127.0.0.1",port:p,path:"/",timeout:1000},x=>{x.resume();process.exit(x.statusCode>=200&&x.statusCode<500?0:1)});r.on("timeout",()=>{r.destroy();process.exit(1)});r.on("error",()=>process.exit(1))' "$PORT" >/dev/null 2>&1; then''',
    '''  if command -v curl >/dev/null 2>&1 && curl --fail --silent --max-time 1 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
    READY=1
    break
  fi
  if command -v wget >/dev/null 2>&1 && wget --quiet --timeout=1 --tries=1 -O /dev/null "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
    READY=1
    break
  fi
  if command -v node >/dev/null 2>&1 && node -e 'const http=require("node:http");const p=Number(process.argv[1]);const r=http.get({host:"127.0.0.1",port:p,path:"/",timeout:1000},x=>{x.resume();process.exit(x.statusCode>=200&&x.statusCode<500?0:1)});r.on("timeout",()=>{r.destroy();process.exit(1)});r.on("error",()=>process.exit(1))' "$PORT" >/dev/null 2>&1; then''',
)
