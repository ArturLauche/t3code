import fs from "node:fs";

function read(file) {
  return fs.readFileSync(file, "utf8");
}
function write(file, value) {
  fs.writeFileSync(file, value);
}
function replaceOnce(file, before, after) {
  const source = read(file);
  if (!source.includes(before)) {
    throw new Error(`Expected text not found in ${file}: ${before.slice(0, 120)}`);
  }
  write(file, source.replace(before, after));
}
function replaceRegex(file, pattern, after, expected = 1) {
  const source = read(file);
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== expected) {
    throw new Error(`Expected ${expected} regex matches in ${file}, got ${matches.length}: ${pattern}`);
  }
  write(file, source.replace(pattern, after));
}

replaceOnce(
  "scripts/release-smoke.ts",
  '  "packages/contracts/package.json",\n',
  '  "packages/contracts/package.json",\n  "packages/github/package.json",\n  "packages/sandbox/package.json",\n',
);

replaceOnce(
  "apps/desktop/vite.config.ts",
  '    process.env.T3CODE_GITHUB_CLIENT_ID?.trim() ?? "",',
  '    repoEnv.T3CODE_GITHUB_CLIENT_ID?.trim() ?? "",',
);

replaceOnce(
  "packages/github/src/redaction.ts",
  '    return result.replace(/(gh[opsu]_[A-Za-z0-9_]{12,})/gu, "[REDACTED]");',
  '    return result.replace(/((?:gh[opsu]_|github_pat_)[A-Za-z0-9_]{12,})/gu, "[REDACTED]");',
);
replaceOnce(
  "packages/github/src/redaction.ts",
  '  const visit = (input: unknown): unknown => {\n    if (typeof input === "string") return redactString(input);',
  '  const visit = (input: unknown): unknown => {\n    if (input instanceof Error) {\n      const redacted = new Error(redactString(input.message), { cause: visit(input.cause) });\n      redacted.name = input.name;\n      if (input.stack) redacted.stack = redactString(input.stack);\n      return redacted;\n    }\n    if (typeof input === "string") return redactString(input);',
);

replaceOnce(
  "packages/github/src/client.ts",
  '  const loadAccessibleRepositories = () => {\n    accessibleRepositories ??= octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {\n      affiliation: "owner,collaborator,organization_member",\n      per_page: 100,\n      sort: "updated",\n    }).then((repositories) => repositories.map(toRepositorySummary));\n    return accessibleRepositories;\n  };',
  '  const loadAccessibleRepositories = () => {\n    accessibleRepositories ??= octokit\n      .paginate(octokit.rest.repos.listForAuthenticatedUser, {\n        affiliation: "owner,collaborator,organization_member",\n        per_page: 100,\n        sort: "updated",\n      })\n      .then((repositories) => repositories.map(toRepositorySummary))\n      .catch((cause) => {\n        accessibleRepositories = null;\n        throw cause;\n      });\n    return accessibleRepositories;\n  };',
);
replaceOnce(
  "packages/github/src/client.ts",
  '      const page = input.page ?? 1;\n      const perPage = Math.min(MAX_PER_PAGE, input.perPage ?? DEFAULT_PER_PAGE);',
  '      const page = input.page ?? 1;\n      const requestedPerPage = input.perPage ?? DEFAULT_PER_PAGE;\n      if (!Number.isInteger(page) || page <= 0) {\n        throw new Error("GitHub repository page must be a positive integer.");\n      }\n      if (!Number.isInteger(requestedPerPage) || requestedPerPage <= 0) {\n        throw new Error("GitHub repository page size must be a positive integer.");\n      }\n      const perPage = Math.min(MAX_PER_PAGE, requestedPerPage);',
);

replaceOnce(
  "packages/contracts/src/executionEnvironment.ts",
  '  autoDeleteMinutes: Schema.optional(Schema.Int),',
  '  autoDeleteMinutes: Schema.optional(NonNegativeInt),',
);
replaceOnce(
  "packages/contracts/src/executionEnvironment.ts",
  '  readonly connect: boolean;\n  readonly status: boolean;',
  '  readonly connect: boolean;\n  readonly start: boolean;\n  readonly status: boolean;',
);
replaceOnce(
  "packages/contracts/src/executionEnvironment.ts",
  '  connect: Schema.Boolean,\n  status: Schema.Boolean,',
  '  connect: Schema.Boolean,\n  start: Schema.Boolean,\n  status: Schema.Boolean,',
);

for (const file of ["packages/sandbox/src/adapters/e2b.ts", "packages/sandbox/src/adapters/novita.ts"]) {
  replaceOnce(file, '    template: info.name ?? info.templateId,', '    template: info.templateId,');
  replaceOnce(
    file,
    '    createdAt: info.startedAt.toISOString(),\n    updatedAt: info.endAt.toISOString(),',
    '    createdAt: info.startedAt.toISOString(),\n    updatedAt: info.startedAt.toISOString(),',
  );
  replaceOnce(
    file,
    '      "t3-ephemeral": input.ephemeral ? "true" : "false",',
    '      "t3-ephemeral": input.ephemeral ? "true" : "false",\n      "t3-timeout-ms": String((input.timeoutMinutes ?? 60) * 60_000),',
  );
  replaceOnce(
    file,
    '      onTimeout: timeoutAction === "delete" ? ("kill" as const) : ("pause" as const),',
    '      onTimeout: timeoutAction === "kill" || timeoutAction === "delete" ? ("kill" as const) : ("pause" as const),',
  );
  replaceOnce(
    file,
    '  const connectInstance = (sandboxId: string, timeoutMs?: number) =>\n    Sandbox.connect(sandboxId, {\n      ...options(input.credential),\n      ...(timeoutMs ? { timeoutMs } : {}),\n    });',
    '  const configuredTimeoutMs = async (sandboxId: string): Promise<number | undefined> => {\n    const info = await getInfo(sandboxId);\n    const metadataTimeout = Number(info.metadata["t3-timeout-ms"]);\n    if (Number.isFinite(metadataTimeout) && metadataTimeout > 0) return metadataTimeout;\n    const remaining = info.endAt.getTime() - Date.now();\n    return remaining > 0 ? remaining : undefined;\n  };\n  const connectInstance = async (sandboxId: string, timeoutMs?: number) =>\n    Sandbox.connect(sandboxId, {\n      ...options(input.credential),\n      ...((timeoutMs ?? (await configuredTimeoutMs(sandboxId)))\n        ? { timeoutMs: timeoutMs ?? (await configuredTimeoutMs(sandboxId)) }\n        : {}),\n    });',
  );
}
replaceOnce(
  "packages/sandbox/src/adapters/e2b.ts",
  '    secure: false,\n',
  '',
);
replaceOnce(
  "packages/sandbox/src/adapters/novita.ts",
  '    connect: async (sandboxId) => {\n      const sandbox = await safely("connect", () => connectInstance(sandboxId));\n      return toRecord(input.connectionId, await sandbox.getInfo());\n    },',
  '    connect: (sandboxId) =>\n      safely("connect", async () => {\n        const sandbox = await connectInstance(sandboxId);\n        return toRecord(input.connectionId, await sandbox.getInfo());\n      }),',
);
replaceOnce(
  "packages/sandbox/src/adapters/novita.ts",
  '    resume: async (sandboxId) => {\n      const sandbox = await safely("resume", () => connectInstance(sandboxId));\n      return toRecord(input.connectionId, await sandbox.getInfo());\n    },',
  '    resume: (sandboxId) =>\n      safely("resume", async () => {\n        const sandbox = await connectInstance(sandboxId);\n        return toRecord(input.connectionId, await sandbox.getInfo());\n      }),',
);

replaceRegex(
  "packages/sandbox/src/adapters/daytona.ts",
  /    automaticShutdown: \{[\s\S]*?    \},\n    \/\/ Daytona uses/gu,
  `    automaticShutdown: (() => {\n      if (sandbox.autoDeleteInterval !== undefined && sandbox.autoDeleteInterval >= 0) {\n        return { action: "delete" as const, timeoutMinutes: sandbox.autoDeleteInterval };\n      }\n      if (sandbox.autoPauseInterval !== undefined && sandbox.autoPauseInterval > 0) {\n        return { action: "pause" as const, timeoutMinutes: sandbox.autoPauseInterval };\n      }\n      if (sandbox.autoStopInterval !== undefined && sandbox.autoStopInterval > 0) {\n        return { action: "stop" as const, timeoutMinutes: sandbox.autoStopInterval };\n      }\n      return {};\n    })(),\n    // Daytona uses`,
);

replaceOnce(
  "packages/ssh/src/command.ts",
  'function redactSshCommandForLogs(',
  'export function redactSshCommandForLogs(',
);
replaceOnce(
  "packages/ssh/src/command.ts",
  '  const logCommand = redactSshCommandForLogs(target, [sshCommand, ...args]);',
  '  const logCommand = redactSshCommandForLogs(target, [sshCommand, ...args]);\n  const logTarget = usesEphemeralUsernameCredential(target)\n    ? target.hostname\n    : hostSpec;',
);
replaceOnce(
  "packages/ssh/src/command.ts",
  ': `Failed to spawn SSH command for ${hostSpec}.`,',
  ': `Failed to spawn SSH command for ${logTarget}.`,',
);
replaceOnce(
  "packages/ssh/src/command.ts",
  '          command: ["ssh", ...args],\n          exitCode: null,\n          stderr: "",\n          message:\n            cause instanceof Error ? cause.message : `Failed to run SSH command for ${hostSpec}.`,',
  '          command: logCommand,\n          exitCode: null,\n          stderr: "",\n          message:\n            cause instanceof Error ? cause.message : `Failed to run SSH command for ${logTarget}.`,',
);
replaceOnce(
  "packages/ssh/src/command.ts",
  '      command: ["ssh", ...args],\n      exitCode,',
  '      command: logCommand,\n      exitCode,',
);
replaceOnce(
  "packages/ssh/src/command.ts",
  '      command: ["ssh", ...args],\n      exitCode,\n      stdout: diagnosticStdout,',
  '      command: logCommand,\n      exitCode,\n      stdout: diagnosticStdout,',
);
replaceOnce(
  "packages/ssh/src/command.ts",
  '        fallbackMessage: `SSH command failed for ${hostSpec} (exit ${exitCode}).`,',
  '        fallbackMessage: `SSH command failed for ${logTarget} (exit ${exitCode}).`,',
);
replaceOnce(
  "packages/ssh/src/command.ts",
  '    command: ["ssh", ...args],\n  });\n  return { stdout, stderr };',
  '    command: logCommand,\n  });\n  return { stdout, stderr };',
);
replaceOnce(
  "packages/ssh/src/tunnel.ts",
  '  runSshCommand,\n  targetConnectionKey,\n  usesEphemeralUsernameCredential,',
  '  runSshCommand,\n  targetConnectionKey,\n  redactSshCommandForLogs,',
);
replaceRegex(
  "packages/ssh/src/tunnel.ts",
  /\nfunction redactSshCommandForLogs\([\s\S]*?\n\}\n\nfunction sshRunnerLogFields/gu,
  '\nfunction sshRunnerLogFields',
);

replaceOnce(
  "apps/desktop/src/app/DesktopIntegrationStore.ts",
  '.makeDirectory(directory, { recursive: true })',
  '.makeDirectory(directory, { recursive: true, mode: 0o700 })',
);
replaceOnce(
  "apps/desktop/src/app/DesktopIntegrationStore.ts",
  '.writeFileString(temporaryPath, `${encoded}\\n`)',
  '.writeFileString(temporaryPath, `${encoded}\\n`, { mode: 0o600 })',
);
replaceOnce(
  "apps/desktop/src/app/DesktopIntegrationStore.ts",
  '    transform: (document: SecretDocument) => readonly [A, SecretDocument],',
  '    transform: (document: SecretDocument) =>\n      | readonly [A, SecretDocument]\n      | Effect.Effect<readonly [A, SecretDocument], DesktopIntegrationStoreError>,',
);
replaceOnce(
  "apps/desktop/src/app/DesktopIntegrationStore.ts",
  '        const [result, next] = transform(current);',
  '        const [result, next] = yield* Effect.fromNullable(transform(current)).pipe(\n          Effect.flatMap((value) => Effect.isEffect(value) ? value : Effect.succeed(value)),\n          Effect.mapError((cause) => fail(operation, cause)),\n        );',
);
replaceOnce(
  "apps/desktop/src/app/DesktopIntegrationStore.ts",
  '        return yield* update("markProviderValidated", (document) => {\n          const stored = document.providers.find(({ connection }) => connection.id === id);\n          if (!stored) throw new Error(`Sandbox provider connection ${id} does not exist.`);',
  '        return yield* update("markProviderValidated", (document) => {\n          const stored = document.providers.find(({ connection }) => connection.id === id);\n          if (!stored) {\n            return fail("markProviderValidated", new Error(`Sandbox provider connection ${id} does not exist.`));\n          }',
);

replaceOnce(
  "apps/server/src/http.ts",
  '    yield* broker.value.injectEphemeral({\n      token: decoded.value.token,\n      ...(decoded.value.ttlSeconds === undefined ? {} : { ttlSeconds: decoded.value.ttlSeconds }),\n    });',
  '    const now = Date.now();\n    const expiresAtEpochMs = decoded.value.expiresAt === undefined\n      ? undefined\n      : Date.parse(decoded.value.expiresAt);\n    if (expiresAtEpochMs !== undefined && (!Number.isFinite(expiresAtEpochMs) || expiresAtEpochMs <= now)) {\n      return HttpServerResponse.text("Credential expiry must be a future timestamp.", { status: 400 });\n    }\n    const requestedTtl = decoded.value.ttlSeconds;\n    const expiryTtl = expiresAtEpochMs === undefined\n      ? undefined\n      : Math.max(1, Math.floor((expiresAtEpochMs - now) / 1_000));\n    const ttlSeconds = requestedTtl === undefined\n      ? expiryTtl\n      : expiryTtl === undefined\n        ? requestedTtl\n        : Math.min(requestedTtl, expiryTtl);\n    yield* broker.value.injectEphemeral({\n      token: decoded.value.token,\n      ...(ttlSeconds === undefined ? {} : { ttlSeconds }),\n    });',
);

replaceOnce(
  "apps/server/src/vcs/VcsProcess.ts",
  '        env: {\n          ...input.env,\n          ...githubEnv,\n        },',
  '        env: {\n          ...(input.env ?? process.env),\n          ...githubEnv,\n        },',
);
replaceOnce(
  "apps/server/src/vcs/GitVcsDriverCore.ts",
  '          ...input.env,\n          ...(Option.isSome(githubEnvironment) ? githubEnvironment.value : {}),',
  '          ...(Option.isSome(githubEnvironment) ? githubEnvironment.value : {}),\n          ...input.env,',
);

replaceOnce(
  "packages/client-runtime/src/connection/onboarding.ts",
  '  const connectionId = `sandbox:${input.target.providerConnectionId}:${input.target.sandboxId}`;',
  '  const connectionId = `sandbox:${JSON.stringify([input.target.provider, input.target.providerConnectionId, input.target.sandboxId])}`;',
);

replaceOnce(
  "apps/web/src/components/settings/CloudSandboxesSettings.tsx",
  '            ...(Number.isFinite(timeout)\n              ? ephemeral',
  '            ...(Number.isFinite(timeout) && timeout > 0\n              ? ephemeral',
);
replaceOnce(
  "apps/web/src/components/settings/CloudSandboxesSettings.tsx",
  '        await bridge\n          .removeCloudSandboxProviderConnection({ id: savedConnection.id })\n          .catch(() => undefined);\n      }\n      setError(errorMessage(cause));',
  '        await bridge\n          .removeCloudSandboxProviderConnection({ id: savedConnection.id })\n          .catch(() => undefined);\n        await onSaved().catch(() => undefined);\n      }\n      setError(errorMessage(cause));',
);
replaceRegex(
  "apps/web/src/components/settings/CloudSandboxesSettings.tsx",
  /<DialogClose render=\{<Button variant="outline" disabled=\{pending\} \/>\}>Cancel<\/DialogClose>/gu,
  '<DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>',
  2,
);

replaceOnce(
  "apps/web/src/components/settings/GitHubConnectionSettings.tsx",
  '  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);',
  '  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);\n  const pollCancelled = useRef(false);',
);
replaceOnce(
  "apps/web/src/components/settings/GitHubConnectionSettings.tsx",
  '  useEffect(() => {\n    void refresh();\n    return () => {\n      if (pollTimer.current) clearTimeout(pollTimer.current);\n    };\n  }, [refresh]);',
  '  useEffect(() => {\n    pollCancelled.current = false;\n    void refresh();\n    return () => {\n      pollCancelled.current = true;\n      if (pollTimer.current) clearTimeout(pollTimer.current);\n    };\n  }, [refresh]);',
);
replaceOnce(
  "apps/web/src/components/settings/GitHubConnectionSettings.tsx",
  '      const next = await bridge.pollGitHubDeviceAuthorization();\n      setStatus(next);',
  '      const next = await bridge.pollGitHubDeviceAuthorization();\n      if (pollCancelled.current) return;\n      setStatus(next);',
);
replaceOnce(
  "apps/web/src/components/settings/GitHubConnectionSettings.tsx",
  '    } catch (cause) {\n      setPending(false);\n      toastManager.add(\n        stackedThreadToast({\n          type: "error",\n          title: "Could not connect GitHub",',
  '    } catch (cause) {\n      if (pollCancelled.current) return;\n      setAuthorization(null);\n      setPending(false);\n      toastManager.add(\n        stackedThreadToast({\n          type: "error",\n          title: "Could not connect GitHub",',
);
replaceOnce(
  "apps/web/src/components/settings/GitHubConnectionSettings.tsx",
  '      pollTimer.current = setTimeout(() => void poll(), authorization.intervalSeconds * 1_000);',
  '      pollCancelled.current = false;\n      pollTimer.current = setTimeout(\n        () => void poll(),\n        Math.max(authorization.intervalSeconds, 2) * 1_000,\n      );',
);
replaceOnce(
  "apps/web/src/components/settings/GitHubConnectionSettings.tsx",
  '  const disconnect = async () => {\n    await bridge.disconnectGitHub();\n    setAuthorization(null);\n    await refresh();\n  };',
  '  const disconnect = async () => {\n    try {\n      await bridge.disconnectGitHub();\n      setAuthorization(null);\n      await refresh();\n    } catch (cause) {\n      toastManager.add(\n        stackedThreadToast({\n          type: "error",\n          title: "Could not disconnect GitHub",\n          description: message(cause),\n        }),\n      );\n    }\n  };',
);

replaceOnce(
  "packages/sandbox/src/bootstrap.ts",
  '  return `if [ -f ${pidFile} ]; then pid=$(cat ${pidFile}); kill "$pid" 2>/dev/null || true; fi; rm -f ${pidFile}; ${launch}`;',
  '  return `if [ -f ${pidFile} ]; then pid=$(cat ${pidFile}); kill "$pid" 2>/dev/null || true; i=0; while kill -0 "$pid" 2>/dev/null; do i=$((i+1)); if [ "$i" -ge 50 ]; then echo "existing t3 server did not stop" >&2; exit 1; fi; sleep 0.1; done; rm -f ${pidFile}; fi; ${launch}`;',
);
replaceOnce(
  "packages/sandbox/src/bootstrap.ts",
  '  return `if [ -f ${pidFile} ]; then pid=$(cat ${pidFile}); kill "$pid" 2>/dev/null || true; fi; rm -f ${pidFile}`;',
  '  return `if [ -f ${pidFile} ]; then pid=$(cat ${pidFile}); kill "$pid" 2>/dev/null || true; i=0; while kill -0 "$pid" 2>/dev/null; do i=$((i+1)); if [ "$i" -ge 50 ]; then echo "t3 server did not stop" >&2; exit 1; fi; sleep 0.1; done; rm -f ${pidFile}; fi`;',
);

console.log("Applied PR review fix stage 1");
