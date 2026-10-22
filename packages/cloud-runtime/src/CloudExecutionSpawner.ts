// @effect-diagnostics nodeBuiltinImport:off - A cloud sandbox is reached over vendor HTTP and
// streamed back as Node streams; Effect has no equivalent for either boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeStream from "node:stream";
import * as NodeStringDecoder from "node:string_decoder";

import type {
  CloudExecutionHandle,
  CloudRuntimeId,
  ProviderInstanceEnvironment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ChildProcess from "effect/process/ChildProcess";

import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import type {
  CloudExecutionCwdResolver,
  CloudExecutionProcess,
  CloudExecutionRuntime,
  CloudPtyOptions,
  CloudSpawnNode,
} from "@t3tools/provider-core/server/cloudExecution";

const MAX_WORKSPACE_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_PENDING_PTY_BYTES = 1024 * 1024;
/** How long a stopped cloud process may take to exit before it is killed. */
const TERMINATE_GRACE_MS = 5_000;

const archiveLimitError = (): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: "InvalidData",
    module: "CloudExecutionSpawner",
    method: "archive",
    description: `workspace archive exceeds ${MAX_WORKSPACE_ARCHIVE_BYTES} bytes`,
  });

// Only non-sensitive runtime defaults are inherited. Provider credentials
// must be explicitly listed in the provider instance environment; inheriting
// process.env here would copy unrelated host credentials into every sandbox.
const CLOUD_ENVIRONMENT_PASSTHROUGH = new Set(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ"]);
const ENVIRONMENT_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/u;

const makeCloudEnvironment = (input: {
  readonly base: NodeJS.ProcessEnv;
  readonly command: Readonly<Record<string, string | undefined>>;
  readonly providerEnvironment: ProviderInstanceEnvironment | undefined;
}): Record<string, string> => {
  const explicitEntries = (input.providerEnvironment ?? []).map(
    (variable) => [variable.name, variable.value] as const,
  );
  const explicitNames = new Set(explicitEntries.map(([name]) => name));
  const source = {
    ...input.base,
    ...input.command,
    ...Object.fromEntries(explicitEntries),
  };
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        ENVIRONMENT_NAME_PATTERN.test(entry[0]) &&
        (explicitNames.has(entry[0]) || CLOUD_ENVIRONMENT_PASSTHROUGH.has(entry[0])),
    ),
  );
};

/**
 * How a provider driver runs its agent when the instance points at a cloud
 * sandbox instead of the local machine.
 *
 * Drivers build this once per instance (see `makeCloudExecutionSpawner`) and
 * hand it to the orchestration adapter, which needs exactly two things: a
 * spawner that launches inside the sandbox, and the mapping from a local
 * workspace path to its remote counterpart for the paths that travel in
 * provider protocol messages.
 *
 * The type itself lives in `@t3tools/provider-core` so the driver interfaces
 * stay free of this package's implementation.
 */
export type CloudExecutionTransport =
  import("@t3tools/provider-core/server/cloudExecution").CloudExecutionTransport;

const cloudPlatformError = (cause: unknown): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "CloudExecutionSpawner",
    method: "spawn",
    cause,
  });

const remoteCommandName = (command: string): string => {
  const normalized = command.replaceAll("\\", "/");
  const name = normalized.split("/").pop() ?? "";
  return name.length > 0 ? name : command;
};

const archiveCommand = (cwd: string, environment: NodeJS.ProcessEnv) =>
  ChildProcess.make(
    "tar",
    [
      "-cf",
      "-",
      "-C",
      cwd,
      "--exclude=.git",
      "--exclude=.t3",
      "--exclude=node_modules",
      "--exclude=.env",
      "--exclude=.env.*",
      "--exclude=*.env",
      "--exclude=*.env.*",
      "--exclude=.envrc",
      "--exclude=.pgpass",
      "--exclude=.gitconfig",
      "--exclude=auth.json",
      "--exclude=.ssh",
      "--exclude=.aws",
      "--exclude=.azure",
      "--exclude=.config",
      "--exclude=.vscode",
      "--exclude=.idea",
      "--exclude=.terraform",
      "--exclude=.serverless",
      "--exclude=.pulumi",
      "--exclude=.kube",
      "--exclude=.gnupg",
      "--exclude=.password-store",
      "--exclude=.docker",
      "--exclude=.npmrc",
      "--exclude=.yarnrc",
      "--exclude=.netrc",
      "--exclude=.htpasswd",
      "--exclude=.pypirc",
      "--exclude=.m2/settings.xml",
      "--exclude=.cargo",
      "--exclude=.gem",
      "--exclude=.claude",
      "--exclude=.codex",
      "--exclude=.freebuff",
      "--exclude=.git-credentials",
      "--exclude=*.pem",
      "--exclude=*.key",
      "--exclude=*.p12",
      "--exclude=*.pfx",
      "--exclude=*.secret",
      "--exclude=*.token",
      "--exclude=id_rsa*",
      "--exclude=id_ed25519*",
      "--exclude=credentials",
      "--exclude=credentials.json",
      "--exclude=secrets",
      "--exclude=secrets.json",
      ".",
    ],
    { env: environment },
  );

const collectArchive = Effect.fn("CloudExecutionSpawner.collectArchive")(function* (
  fileSystem: FileSystem.FileSystem,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  cwd: string,
  environment: NodeJS.ProcessEnv,
) {
  if (!(yield* fileSystem.exists(cwd))) {
    return yield* PlatformError.systemError({
      _tag: "NotFound",
      module: "CloudExecutionSpawner",
      method: "archive",
      pathOrDescriptor: cwd,
    });
  }
  const handle = yield* spawner.spawn(archiveCommand(cwd, environment));
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const collectStdout = Stream.runForEach(handle.stdout, (chunk) => {
    const nextSize = totalBytes + chunk.byteLength;
    if (nextSize > MAX_WORKSPACE_ARCHIVE_BYTES) {
      return Effect.fail(archiveLimitError());
    }
    return Effect.sync(() => {
      totalBytes = nextSize;
      chunks.push(chunk);
    });
  });
  const [, , exitCode] = yield* Effect.all(
    [collectStdout, Stream.runDrain(handle.stderr), handle.exitCode],
    { concurrency: "unbounded" },
  ).pipe(
    // `tar` is a host process, so it has to die on every non-clean exit: a
    // size limit, a failed sibling, and an abandoned request all leave it
    // running and holding the workspace open otherwise.
    Effect.onExit((exit) =>
      Exit.isSuccess(exit) ? Effect.void : handle.kill().pipe(Effect.ignore),
    ),
  );
  if (Number(exitCode) !== 0) {
    return yield* PlatformError.systemError({
      _tag: "Unknown",
      module: "CloudExecutionSpawner",
      method: "archive",
      description: `tar exited with code ${Number(exitCode)}`,
    });
  }
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (bytes.byteLength > MAX_WORKSPACE_ARCHIVE_BYTES) {
    return yield* PlatformError.systemError({
      _tag: "InvalidData",
      module: "CloudExecutionSpawner",
      method: "archive",
      description: `workspace archive exceeds ${MAX_WORKSPACE_ARCHIVE_BYTES} bytes`,
    });
  }
  return bytes;
});

/**
 * Child-process transport used by Codex/Claude when a provider instance opts
 * into a cloud execution target. The provider adapters keep their native
 * protocol parsers; only process creation and workspace materialization move
 * below the boundary.
 */
export const makeCloudExecutionSpawner = Effect.fn("makeCloudExecutionSpawner")(function* (input: {
  readonly cloud: CloudExecutionRuntime;
  readonly localSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly runtimeId: CloudRuntimeId;
  readonly instanceId: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly providerEnvironment?: ProviderInstanceEnvironment | undefined;
  readonly sandboxPrefix: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const prepared = new Map<string, CloudExecutionHandle>();
  const activeProcesses = new Map<string, number>();
  const sandboxNameFor = (cwd: string): string => {
    const digest = NodeCrypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12);
    return `${input.sandboxPrefix}-${digest}`.replaceAll(/[^a-zA-Z0-9_-]/gu, "-");
  };
  const remoteCwdFor: CloudExecutionCwdResolver = (cwd) =>
    prepared.get(cwd)?.remoteCwd ?? `/workspace/${sandboxNameFor(cwd)}`;
  const invalidatePrepared = (cwd: string) => {
    if ((activeProcesses.get(cwd) ?? 0) === 0) prepared.delete(cwd);
  };
  // Serialise the first preparation for each provider instance. Without a
  // lock, concurrent turns can both observe an empty sandbox and create two
  // paid remote environments. The handle is cached while a process is active;
  // once it exits, the next turn refreshes the workspace snapshot.
  const preparationLock = yield* Semaphore.make(1);

  const prepareFor = (cwd: string) =>
    preparationLock.withPermits(1)(
      Effect.gen(function* () {
        const existing = prepared.get(cwd);
        if (existing) return existing;
        const name = sandboxNameFor(cwd);
        const archive = yield* collectArchive(
          fileSystem,
          input.localSpawner,
          cwd,
          makeCloudEnvironment({
            base: input.environment,
            command: {},
            providerEnvironment: undefined,
          }),
        );
        const handle = yield* input.cloud
          .prepareExecution({
            runtimeId: input.runtimeId,
            name,
            metadata: { t3ProviderInstanceId: input.instanceId },
            workspaceArchive: archive,
          })
          .pipe(
            Effect.mapError(cloudPlatformError),
            Effect.tapError(() => Effect.sync(() => invalidatePrepared(cwd))),
          );
        prepared.set(cwd, handle);
        return handle;
      }),
    );

  // Typed with the concrete `CloudProcess` so `terminate` and the PTY adapter see the
  // full class surface; the exported transport narrows it to `CloudSpawnNode`.
  const spawnNode = Effect.fn("CloudExecutionSpawner.spawnNode")(function* (
    command: ChildProcess.Command,
    pty?: CloudPtyOptions,
  ) {
    if (command._tag === "PipedCommand") {
      return yield* PlatformError.systemError({
        _tag: "BadResource",
        module: "CloudExecutionSpawner",
        method: "spawn",
        description: "piped local commands are not supported by cloud execution",
      });
    }
    const cwd: string = command.options.cwd ?? process.cwd();
    const handle = yield* prepareFor(cwd);
    const remoteHome =
      handle.remoteHome ?? `/tmp/t3-home-${handle.sandboxId.replaceAll(/[^a-zA-Z0-9_-]/gu, "-")}`;
    const environment = {
      ...makeCloudEnvironment({
        base: input.environment,
        command: command.options.env ?? {},
        providerEnvironment: input.providerEnvironment,
      }),
      T3_CLOUD_EXECUTION: "1",
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: remoteHome,
      CLAUDE_CONFIG_DIR: `${remoteHome}/.claude`,
      CODEX_HOME: `${remoteHome}/.codex`,
      FREEBUFF_CONFIG_DIR: `${remoteHome}/.freebuff`,
    };
    const remoteArgs = command.args.map((argument) =>
      argument === cwd ? handle.remoteCwd : argument,
    );
    const cloudProcess = yield* input.cloud
      .startProcess(handle.runtimeId, handle.sandboxId, {
        command: remoteCommandName(command.command),
        args: remoteArgs,
        cwd: handle.remoteCwd,
        env: environment,
        timeoutSeconds: 86_400,
        ...(pty ? { pty } : {}),
      })
      .pipe(
        Effect.mapError(cloudPlatformError),
        Effect.tapError(() => Effect.sync(() => invalidatePrepared(cwd))),
      );
    const active = (activeProcesses.get(cwd) ?? 0) + 1;
    activeProcesses.set(cwd, active);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const remaining = Math.max(0, (activeProcesses.get(cwd) ?? 1) - 1);
      if (remaining === 0) activeProcesses.delete(cwd);
      else activeProcesses.set(cwd, remaining);
      invalidatePrepared(cwd);
    };
    cloudProcess.once("exit", release);
    void cloudProcess.wait().then(release, release);
    return cloudProcess;
  });

  /**
   * Stop a cloud process, escalating so a release never returns while the
   * vendor keeps billing for it. SIGTERM is the polite path; a provider CLI
   * that ignores it is killed outright rather than abandoned mid-turn.
   */
  const terminate = (cloudProcess: CloudExecutionProcess) =>
    Effect.suspend(() => {
      if (cloudProcess.completed) return Effect.void;
      cloudProcess.kill("SIGTERM");
      const waitForExit = Effect.promise(() => cloudProcess.wait()).pipe(Effect.asVoid);
      return waitForExit.pipe(
        Effect.timeoutOption(TERMINATE_GRACE_MS),
        Effect.flatMap((graceful) =>
          graceful._tag === "Some" || cloudProcess.completed
            ? Effect.void
            : Effect.sync(() => {
                cloudProcess.kill("SIGKILL");
              }).pipe(Effect.andThen(waitForExit), Effect.timeoutOption(TERMINATE_GRACE_MS)),
        ),
        Effect.asVoid,
      );
    });

  const spawn = (command: ChildProcess.Command) =>
    Effect.acquireRelease(spawnNode(command), terminate).pipe(
      Effect.map((cloudProcess) => cloudProcess.asChildProcessHandle()),
    );

  return {
    spawner: ChildProcessSpawner.make(spawn),
    spawnNode,
    remoteCwdFor,
  };
});

/** Adapt the cloud process stream to the PTY contract used by terminal agents. */
export const makeCloudPtyAdapter = (spawnNode: CloudSpawnNode): PtyAdapter.PtyAdapterService => ({
  spawn: (input) =>
    spawnNode(
      ChildProcess.make(input.shell, input.args ?? [], {
        cwd: input.cwd,
        env: input.env,
      }),
      { cols: input.cols, rows: input.rows },
    ).pipe(
      Effect.scoped,
      Effect.mapError(
        (cause) =>
          new PtyAdapter.PtySpawnError({
            adapter: "cloud",
            shell: input.shell,
            cause,
          }),
      ),
      Effect.map((process) => {
        const onDataListeners = new Set<(data: string) => void>();
        const onExitListeners = new Set<
          (event: { readonly exitCode: number; readonly signal: number | null }) => void
        >();
        const pendingData: string[] = [];
        let pendingBytes = 0;
        const stdoutDecoder = new NodeStringDecoder.StringDecoder("utf8");
        const stderrDecoder = new NodeStringDecoder.StringDecoder("utf8");
        let exitEvent: { readonly exitCode: number; readonly signal: number | null } | undefined;

        const emitData = (value: string) => {
          if (!value) return;
          if (onDataListeners.size === 0) {
            pendingData.push(value);
            pendingBytes += Buffer.byteLength(value);
            while (pendingBytes > MAX_PENDING_PTY_BYTES && pendingData.length > 0) {
              const discarded = pendingData.shift();
              pendingBytes -= discarded ? Buffer.byteLength(discarded) : 0;
            }
            return;
          }
          for (const listener of onDataListeners) listener(value);
        };
        const onStdout = (data: Buffer | string) => {
          emitData(stdoutDecoder.write(Buffer.isBuffer(data) ? data : Buffer.from(data)));
        };
        const onStderr = (data: Buffer | string) => {
          emitData(stderrDecoder.write(Buffer.isBuffer(data) ? data : Buffer.from(data)));
        };
        const onExit = (exitCode: number | null) => {
          if (exitEvent) return;
          emitData(stdoutDecoder.end());
          emitData(stderrDecoder.end());
          exitEvent = { exitCode: exitCode ?? 1, signal: null };
          for (const listener of onExitListeners) listener(exitEvent);
        };

        // Subscribe before checking completion so an exit cannot fall into the
        // gap between spawning and the caller's onExit registration.
        process.stdout.on("data", onStdout);
        process.stderr.on("data", onStderr);
        process.once("exit", onExit);
        if (process.completed) onExit(process.exitCode);

        return {
          pid: process.pid,
          write: (data) => {
            process.write(data);
          },
          resize: (cols, rows) => {
            process.resize(cols, rows);
          },
          kill: (signal) => {
            process.kill((signal ?? "SIGTERM") as NodeJS.Signals);
          },
          onData: (listener) => {
            onDataListeners.add(listener);
            for (const value of pendingData.splice(0)) listener(value);
            pendingBytes = 0;
            return () => {
              onDataListeners.delete(listener);
            };
          },
          onExit: (listener) => {
            onExitListeners.add(listener);
            if (exitEvent) listener(exitEvent);
            return () => {
              onExitListeners.delete(listener);
            };
          },
        } satisfies PtyAdapter.PtyProcess;
      }),
    ),
});
