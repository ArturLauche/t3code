import * as NodeCrypto from "node:crypto";
import type {
  CloudRuntimeConfig,
  CloudRuntimeId,
  CloudRuntimeKind,
  CloudRuntimeSandboxAction,
  CloudSandboxSummary,
} from "@t3tools/contracts";

import { CloudProcess } from "./CloudProcess.ts";

export interface CloudPtySpec {
  readonly cols: number;
  readonly rows: number;
}

export interface CloudCommandSpec {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutSeconds: number;
  /** When present, run the command through the vendor's real PTY API. */
  readonly pty?: CloudPtySpec;
}

export interface CloudCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CloudSandboxCreateSpec {
  readonly name?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface CloudVendorAdapter {
  readonly kind: CloudRuntimeKind;
  readonly listSandboxes: () => Promise<ReadonlyArray<CloudSandboxSummary>>;
  readonly createSandbox: (input: CloudSandboxCreateSpec) => Promise<CloudSandboxSummary>;
  readonly execute: (sandboxId: string, command: CloudCommandSpec) => Promise<CloudCommandResult>;
  readonly startProcess: (sandboxId: string, command: CloudCommandSpec) => Promise<CloudProcess>;
  readonly action: (sandboxId: string, action: CloudRuntimeSandboxAction) => Promise<void>;
  readonly uploadFile: (sandboxId: string, remotePath: string, data: Uint8Array) => Promise<void>;
  readonly downloadFile: (sandboxId: string, remotePath: string) => Promise<Uint8Array>;
  readonly close?: () => Promise<void>;
}

export const makeCloudVendorAdapter = (input: {
  readonly runtimeId: CloudRuntimeId;
  readonly config: CloudRuntimeConfig;
  readonly apiKey: string;
}): CloudVendorAdapter => {
  switch (input.config.kind) {
    case "e2b":
      return makeE2BCompatibleVendor(input, "e2b");
    case "novita":
      return makeE2BCompatibleVendor(input, "novita");
    case "daytona":
      return makeDaytonaVendor(input);
  }
};

type E2BCompatibleSandbox = {
  readonly sandboxId: string;
  readonly commands: {
    run(
      command: string,
      options: {
        readonly cwd?: string;
        readonly envs?: Record<string, string>;
        readonly timeoutMs?: number;
        readonly background: boolean;
        readonly stdin?: boolean;
        readonly onStdout?: (data: string) => void;
        readonly onStderr?: (data: string) => void;
      },
    ): Promise<{
      readonly pid: number;
      readonly sendStdin?: (data: string | Uint8Array) => Promise<void>;
      readonly closeStdin?: () => Promise<void>;
      readonly kill?: () => Promise<boolean>;
      readonly disconnect?: () => Promise<void>;
      readonly wait: () => Promise<{
        readonly exitCode: number;
        readonly stdout: string;
        readonly stderr: string;
      }>;
      readonly exitCode?: number;
      readonly stdout?: string;
      readonly stderr?: string;
    }>;
    sendStdin(pid: number, data: string | Uint8Array): Promise<void>;
    closeStdin(pid: number): Promise<void>;
    kill(pid: number): Promise<boolean>;
  };
  readonly pty?: {
    create(options: {
      readonly cols: number;
      readonly rows: number;
      readonly cwd?: string;
      readonly envs?: Record<string, string>;
      readonly timeoutMs?: number;
      readonly onData: (data: Uint8Array) => void;
    }): Promise<{
      readonly pid: number;
      readonly sendInput: (data: string | Uint8Array) => Promise<void>;
      readonly kill: () => Promise<boolean>;
      readonly resize: (cols: number, rows: number) => Promise<void>;
      readonly wait: () => Promise<{ readonly exitCode: number }>;
      readonly disconnect?: () => Promise<void>;
      readonly exitCode?: number;
    }>;
  };
  readonly files: {
    write(path: string, data: Uint8Array): Promise<unknown>;
    read(path: string, options: { readonly format: "bytes" }): Promise<Uint8Array>;
  };
  readonly getInfo: () => Promise<{
    readonly sandboxId: string;
    readonly name?: string;
    readonly metadata?: Record<string, string>;
    readonly state: string;
    readonly startedAt: Date;
  }>;
  readonly getHost: (port: number) => string;
};

type E2BCompatibleSandboxConstructor = {
  create(options: {
    readonly apiKey: string;
    readonly domain?: string;
    readonly template?: string;
    readonly timeoutMs?: number;
    readonly metadata?: Record<string, string>;
  }): Promise<E2BCompatibleSandbox>;
  connect(
    sandboxId: string,
    options: { readonly apiKey: string; readonly domain?: string },
  ): Promise<E2BCompatibleSandbox>;
  getInfo(
    sandboxId: string,
    options: { readonly apiKey: string; readonly domain?: string },
  ): Promise<{
    readonly sandboxId: string;
    readonly name?: string;
    readonly metadata?: Record<string, string>;
    readonly state: string;
    readonly startedAt: Date;
  }>;
  list(options: {
    readonly apiKey: string;
    readonly domain?: string;
    readonly query?: { readonly metadata?: Record<string, string> };
  }): {
    hasNext: boolean;
    nextItems(): Promise<ReadonlyArray<unknown>>;
  };
  pause(
    sandboxId: string,
    options: { readonly apiKey: string; readonly domain?: string },
  ): Promise<boolean>;
  kill(
    sandboxId: string,
    options: { readonly apiKey: string; readonly domain?: string },
  ): Promise<boolean>;
};

const DEFAULT_SANDBOX_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const ENVIRONMENT_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/u;

const safeVendorProcessError = (secrets: ReadonlyArray<string>, cause: unknown): Error => {
  const raw = cause instanceof Error ? cause.message : String(cause);
  let message = raw;
  for (const secret of secrets) {
    if (secret.length > 0) message = message.replaceAll(secret, "[redacted]");
  }
  return new Error((message || "Cloud process operation failed.").slice(0, 1_000));
};

const shellCommand = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}): string => [input.command, ...input.args].map(shellQuote).join(" ");

const shellCommandWithContext = (input: CloudCommandSpec): string => {
  const exports = Object.entries(input.env)
    .filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && ENVIRONMENT_NAME_PATTERN.test(entry[0]),
    )
    .map(([name, value]) => `export ${name}=${shellQuote(value)}`);
  const cd = input.cwd ? `cd ${shellQuote(input.cwd)} && ` : "";
  return `${cd}${exports.length > 0 ? `${exports.join(" ")} && ` : ""}${shellCommand(input)}`;
};

const connectionOptions = (input: {
  readonly config: CloudRuntimeConfig;
  readonly apiKey: string;
}) => ({
  apiKey: input.apiKey,
  ...(input.config.domain ? { domain: input.config.domain } : {}),
});

const normalizeE2BState = (state: string): CloudSandboxSummary["state"] =>
  state === "running" ? "running" : state === "paused" ? "paused" : "unknown";

const isE2BInfo = (value: unknown): value is { readonly sandboxId: string } =>
  typeof value === "object" &&
  value !== null &&
  "sandboxId" in value &&
  typeof (value as { readonly sandboxId?: unknown }).sandboxId === "string";

const makeE2BCompatibleVendor = (
  input: {
    readonly runtimeId: CloudRuntimeId;
    readonly config: CloudRuntimeConfig;
    readonly apiKey: string;
  },
  kind: "e2b" | "novita",
): CloudVendorAdapter => {
  // E2B and Novita intentionally expose the same command/filesystem shape.
  // Keep the imports lazy so the server only loads the selected vendor SDK.
  const load = async (): Promise<E2BCompatibleSandboxConstructor> => {
    if (kind === "e2b") {
      return (await import("e2b")).Sandbox as unknown as E2BCompatibleSandboxConstructor;
    }
    return (await import("novita-sandbox")).Sandbox as unknown as E2BCompatibleSandboxConstructor;
  };

  const connect = async (sandboxId: string): Promise<E2BCompatibleSandbox> => {
    const Sandbox = await load();
    return Sandbox.connect(sandboxId, connectionOptions(input));
  };

  const summarize = async (sandbox: E2BCompatibleSandbox): Promise<CloudSandboxSummary> => {
    const info = await sandbox.getInfo();
    return {
      runtimeId: "" as CloudSandboxSummary["runtimeId"],
      kind,
      sandboxId: info.sandboxId,
      name: info.metadata?.name ?? info.name ?? null,
      state: normalizeE2BState(info.state),
      createdAt: info.startedAt.toISOString(),
      ...(info.metadata ? { metadata: info.metadata } : {}),
    };
  };

  return {
    kind,
    listSandboxes: async () => {
      const Sandbox = await load();
      const paginator = Sandbox.list({
        ...connectionOptions(input),
        query: { metadata: { t3RuntimeId: input.runtimeId } },
      });
      const infos: Array<unknown> = [];
      while (paginator.hasNext) infos.push(...(await paginator.nextItems()));
      const result: Array<CloudSandboxSummary> = [];
      for (const value of infos) {
        if (!isE2BInfo(value)) continue;
        const info = await Sandbox.getInfo(value.sandboxId, connectionOptions(input));
        result.push({
          runtimeId: input.runtimeId,
          kind,
          sandboxId: info.sandboxId,
          name: info.metadata?.name ?? info.name ?? null,
          state: normalizeE2BState(info.state),
          createdAt: info.startedAt.toISOString(),
          ...(info.metadata ? { metadata: info.metadata } : {}),
        });
      }
      return result;
    },
    createSandbox: async (create) => {
      const Sandbox = await load();
      const sandbox = await Sandbox.create({
        ...connectionOptions(input),
        ...(input.config.template ? { template: input.config.template } : {}),
        timeoutMs: DEFAULT_SANDBOX_TIMEOUT_MS,
        metadata: {
          ...create.metadata,
          t3ManagedExecution: "true",
          t3RuntimeId: input.runtimeId,
          ...(create.name ? { name: create.name } : {}),
        },
      });
      const summary = await summarize(sandbox);
      return {
        ...summary,
        ...(create.name ? { name: create.name } : {}),
      };
    },
    execute: async (sandboxId, command) => {
      const sandbox = await connect(sandboxId);
      const result = await sandbox.commands.run(shellCommand(command), e2bCommandOptions(command));
      if (result.exitCode === undefined) {
        throw new Error("Cloud command completed without an exit code.");
      }
      return {
        exitCode: result.exitCode,
        stdout: (result.stdout ?? "").slice(0, 1_000_000),
        stderr: (result.stderr ?? "").slice(0, 1_000_000),
      };
    },
    startProcess: async (sandboxId, command) => {
      const sandbox = await connect(sandboxId);
      const process = new CloudProcess();
      const safeProcessError = (cause: unknown) =>
        safeVendorProcessError([input.apiKey, ...Object.values(command.env)], cause);
      if (command.pty) {
        if (!sandbox.pty) {
          throw new Error("The selected cloud vendor does not expose a PTY API.");
        }
        const handle = await sandbox.pty.create({
          cols: command.pty.cols,
          rows: command.pty.rows,
          ...(command.cwd ? { cwd: command.cwd } : {}),
          envs: { ...command.env },
          timeoutMs: command.timeoutSeconds * 1_000,
          onData: (data) => process.stdout.write(data),
        });
        process.pid = handle.pid;
        process.stdin.on("data", (data: Buffer) => {
          if (process.killed || process.completed) return;
          void handle
            .sendInput(data)
            .catch((cause) => process.emit("error", safeProcessError(cause)));
        });
        process.stdin.once("end", () => {
          if (process.killed || process.completed) return;
          void handle
            .sendInput("\u0004")
            .catch((cause) => process.emit("error", safeProcessError(cause)));
        });
        process.setKillHandler(() => handle.kill());
        process.setResizeHandler((cols, rows) => handle.resize(cols, rows));
        // The vendor PTY starts an interactive shell. Replace that shell with
        // the provider process so the PTY completes when the agent exits.
        await handle.sendInput(`exec ${shellCommand(command)}\n`);
        void handle
          .wait()
          .then((result) => process.complete(result.exitCode))
          .catch(async (cause) => {
            await handle.kill().catch(() => undefined);
            const exitCode = handle.exitCode;
            if (exitCode === undefined) process.emit("error", safeProcessError(cause));
            process.complete(exitCode ?? null, exitCode === undefined ? "SIGKILL" : null);
          })
          .finally(async () => {
            if (handle.disconnect) await handle.disconnect().catch(() => undefined);
          });
        return process;
      }
      const handle = await sandbox.commands.run(
        shellCommand(command),
        e2bCommandOptions(command, {
          background: true,
          stdin: true,
          onStdout: (data) => process.stdout.write(data),
          onStderr: (data) => process.stderr.write(data),
        }),
      );
      process.pid = handle.pid;
      process.stdin.on("data", (data: Buffer) => {
        if (process.killed || process.completed) return;
        const send = handle.sendStdin
          ? handle.sendStdin(data)
          : sandbox.commands.sendStdin(handle.pid, data);
        void send.catch((cause) => process.emit("error", safeProcessError(cause)));
      });
      process.stdin.once("end", () => {
        if (process.killed || process.completed) return;
        const close = handle.closeStdin
          ? handle.closeStdin()
          : sandbox.commands.closeStdin(handle.pid);
        void close.catch((cause) => process.emit("error", safeProcessError(cause)));
      });
      process.setKillHandler(() => handle.kill?.() ?? sandbox.commands.kill(handle.pid));
      void handle
        .wait()
        .then((result) => process.complete(result.exitCode))
        .catch(async (cause) => {
          await (handle.kill?.() ?? sandbox.commands.kill(handle.pid)).catch(() => undefined);
          const exitCode = handle.exitCode;
          if (exitCode === undefined) process.emit("error", safeProcessError(cause));
          process.complete(exitCode ?? null, exitCode === undefined ? "SIGKILL" : null);
        })
        .finally(async () => {
          if (handle.disconnect) await handle.disconnect().catch(() => undefined);
        });
      return process;
    },
    action: async (sandboxId, action) => {
      const Sandbox = await load();
      if (action === "pause") {
        await Sandbox.pause(sandboxId, connectionOptions(input));
        return;
      }
      if (action === "resume") {
        await Sandbox.connect(sandboxId, connectionOptions(input));
        return;
      }
      if (action === "stop") {
        // E2B-compatible APIs expose pause rather than a reversible stop.
        // Preserve the sandbox so a later resume remains possible.
        await Sandbox.pause(sandboxId, connectionOptions(input));
        return;
      }
      if (action === "delete") {
        await Sandbox.kill(sandboxId, connectionOptions(input));
      }
    },
    uploadFile: async (sandboxId, remotePath, data) => {
      const sandbox = await connect(sandboxId);
      await sandbox.files.write(remotePath, data);
    },
    downloadFile: async (sandboxId, remotePath) => {
      const sandbox = await connect(sandboxId);
      return sandbox.files.read(remotePath, { format: "bytes" });
    },
  };
};

const e2bCommandOptions = (
  command: CloudCommandSpec,
  overrides: Partial<{
    background: boolean;
    stdin: boolean;
    onStdout: (data: string) => void;
    onStderr: (data: string) => void;
  }> = {},
) => ({
  ...(command.cwd ? { cwd: command.cwd } : {}),
  envs: { ...command.env },
  timeoutMs: command.timeoutSeconds * 1_000,
  background: false,
  ...overrides,
});

type DaytonaSandbox = {
  readonly id: string;
  readonly name: string;
  readonly state?: string;
  readonly createdAt?: string;
  readonly labels?: Record<string, string>;
  readonly process: {
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ): Promise<{ readonly exitCode: number; readonly result: string }>;
    createSession(sessionId: string): Promise<void>;
    deleteSession(sessionId: string): Promise<void>;
    executeSessionCommand(
      sessionId: string,
      request: { readonly command: string; readonly runAsync: boolean },
      timeout?: number,
    ): Promise<{ readonly cmdId: string }>;
    sendSessionCommandInput(sessionId: string, commandId: string, data: string): Promise<void>;
    getSessionCommand(
      sessionId: string,
      commandId: string,
    ): Promise<{ readonly exitCode: number | null }>;
    getSessionCommandLogs(
      sessionId: string,
      commandId: string,
      onStdout: (chunk: string) => void,
      onStderr: (chunk: string) => void,
    ): Promise<void>;
    createPty?(options: {
      readonly id: string;
      readonly cols: number;
      readonly rows: number;
      readonly cwd?: string;
      readonly envs?: Record<string, string>;
      readonly onData: (data: Uint8Array) => void;
    }): Promise<{
      readonly pid?: number;
      readonly sessionId: string;
      readonly sendInput: (data: string | Uint8Array) => Promise<void>;
      readonly kill: () => Promise<void>;
      readonly resize: (cols: number, rows: number) => Promise<unknown>;
      readonly waitForConnection: () => Promise<void>;
      readonly wait: () => Promise<{ readonly exitCode: number | null }>;
      readonly disconnect?: () => Promise<void>;
    }>;
  };
  readonly fs: {
    uploadFile(data: Uint8Array, remotePath: string): Promise<void>;
    downloadFile(remotePath: string): Promise<Buffer>;
  };
  start(timeout?: number): Promise<void>;
  stop(timeout?: number, force?: boolean): Promise<void>;
  pause(timeout?: number): Promise<void>;
  delete(timeout?: number, wait?: boolean): Promise<void>;
};

type DaytonaClient = {
  create(input: {
    readonly name?: string;
    readonly snapshot?: string;
    readonly labels?: Record<string, string>;
    readonly autoPauseInterval?: number;
    readonly autoDeleteInterval?: number;
    readonly ttlMinutes?: number;
  }): Promise<DaytonaSandbox>;
  get(sandboxId: string): Promise<DaytonaSandbox>;
  list(input?: { readonly labels?: Record<string, string> }): AsyncIterable<DaytonaSandbox>;
  delete(sandbox: DaytonaSandbox, timeout?: number, wait?: boolean): Promise<void>;
  close(): Promise<void>;
};

const normalizeDaytonaState = (state: string | undefined): CloudSandboxSummary["state"] => {
  switch (state) {
    case "started":
    case "running":
      return "running";
    case "pausing":
    case "paused":
      return "paused";
    case "stopping":
    case "stopped":
      return "stopped";
    case "error":
      return "error";
    default:
      return "unknown";
  }
};

const makeDaytonaVendor = (input: {
  readonly runtimeId: CloudRuntimeId;
  readonly config: CloudRuntimeConfig;
  readonly apiKey: string;
}): CloudVendorAdapter => {
  const load = async (): Promise<DaytonaClient> => {
    const { Daytona } = await import("@daytona/sdk");
    const client = new Daytona({
      apiKey: input.apiKey,
      requestTimeoutMs: 30_000,
      ...(input.config.apiUrl ? { apiUrl: input.config.apiUrl } : {}),
      ...(input.config.region ? { target: input.config.region } : {}),
    });

    return Object.assign(client, {
      close: () => client[Symbol.asyncDispose](),
    }) as unknown as DaytonaClient;
  };

  const summarize = (sandbox: DaytonaSandbox): CloudSandboxSummary => ({
    runtimeId: input.runtimeId,
    kind: "daytona",
    sandboxId: sandbox.id,
    name: sandbox.name || null,
    state: normalizeDaytonaState(sandbox.state),
    createdAt: sandbox.createdAt ?? null,
    ...(sandbox.labels ? { metadata: sandbox.labels } : {}),
  });

  return {
    kind: "daytona",
    listSandboxes: async () => {
      const daytona = await load();
      const result: Array<CloudSandboxSummary> = [];
      try {
        for await (const sandbox of daytona.list({
          labels: { t3RuntimeId: input.runtimeId },
        })) {
          result.push(summarize(sandbox));
        }
        return result;
      } finally {
        await daytona.close();
      }
    },
    createSandbox: async (create) => {
      const daytona = await load();
      try {
        const sandbox = await daytona.create({
          labels: {
            ...create.metadata,
            t3ManagedExecution: "true",
            t3RuntimeId: input.runtimeId,
            ...(create.name ? { name: create.name } : {}),
          },
          ...(create.name ? { name: create.name } : {}),
          ...(input.config.template ? { snapshot: input.config.template } : {}),
          ...(input.config.autoPauseMinutes !== undefined
            ? { autoPauseInterval: input.config.autoPauseMinutes }
            : {}),
          // Bound paid resources even if a provider process disappears.
          autoDeleteInterval: 24 * 60,
        });
        return summarize(sandbox);
      } finally {
        await daytona.close();
      }
    },
    execute: async (sandboxId, command) => {
      const daytona = await load();
      try {
        const sandbox = await daytona.get(sandboxId);
        const result = await sandbox.process.executeCommand(
          shellCommandWithContext(command),
          command.cwd,
          { ...command.env },
          command.timeoutSeconds,
        );
        return {
          exitCode: result.exitCode,
          stdout: result.result.slice(0, 1_000_000),
          stderr: "",
        };
      } finally {
        await daytona.close();
      }
    },
    startProcess: async (sandboxId, command) => {
      const daytona = await load();
      const close = () => daytona.close().catch(() => undefined);
      let cleanupEnvironment: (() => Promise<void>) | undefined;
      let sessionCreated = false;
      try {
        const sandbox = await daytona.get(sandboxId);
        const process = new CloudProcess();
        const safeProcessError = (cause: unknown) =>
          safeVendorProcessError([input.apiKey, ...Object.values(command.env)], cause);
        if (command.pty) {
          if (!sandbox.process.createPty) {
            throw new Error("The selected cloud vendor does not expose a PTY API.");
          }
          const sessionId = `t3-${input.runtimeId}-${NodeCrypto.randomUUID()}`;
          const handle = await sandbox.process.createPty({
            id: sessionId,
            cols: command.pty.cols,
            rows: command.pty.rows,
            ...(command.cwd ? { cwd: command.cwd } : {}),
            envs: { ...command.env },
            onData: (data) => process.stdout.write(data),
          });
          process.stdin.on("data", (data: Buffer) => {
            if (process.killed || process.completed) return;
            void handle
              .sendInput(data)
              .catch((cause) => process.emit("error", safeProcessError(cause)));
          });
          process.stdin.once("end", () => {
            if (process.killed || process.completed) return;
            void handle
              .sendInput("\u0004")
              .catch((cause) => process.emit("error", safeProcessError(cause)));
          });
          process.setKillHandler(async () => {
            await handle.kill();
            return true;
          });
          process.setResizeHandler(async (cols, rows) => {
            await handle.resize(cols, rows);
          });
          await handle.waitForConnection();
          await handle.sendInput(`exec ${shellCommand(command)}\n`);
          void handle
            .wait()
            .then((result) => process.complete(result.exitCode ?? null))
            .catch(async (cause) => {
              await handle.kill().catch(() => undefined);
              process.emit("error", safeProcessError(cause));
              process.complete(null, "SIGKILL");
            })
            .finally(async () => {
              if (handle.disconnect) await handle.disconnect().catch(() => undefined);
              await close();
            });
          return process;
        }
        const sessionId = `t3-${input.runtimeId}-${NodeCrypto.randomUUID()}`;
        const environmentPath = `/tmp/t3-env-${NodeCrypto.randomUUID()}.sh`;
        const environmentScript = `${Object.entries(command.env)
          .filter(([name, value]) => value !== undefined && ENVIRONMENT_NAME_PATTERN.test(name))
          .map(([name, value]) => `export ${name}=${shellQuote(value)}`)
          .join("\n")}\n`;
        cleanupEnvironment = async () => {
          if (sessionCreated) {
            await sandbox.process.deleteSession(sessionId).catch(() => undefined);
          }
          await sandbox.process
            .executeCommand(`rm -f ${shellQuote(environmentPath)}`)
            .catch(() => undefined);
        };
        await sandbox.fs.uploadFile(Buffer.from(environmentScript, "utf8"), environmentPath);
        await sandbox.process.createSession(sessionId);
        sessionCreated = true;
        const started = await sandbox.process.executeSessionCommand(
          sessionId,
          {
            command: `source ${shellQuote(environmentPath)} && ${shellCommandWithContext({
              ...command,
              env: {},
            })}`,
            runAsync: true,
          },
          command.timeoutSeconds,
        );
        process.stdin.on("data", (data: Buffer) => {
          if (process.killed || process.completed) return;
          void sandbox.process
            .sendSessionCommandInput(sessionId, started.cmdId, data.toString("utf8"))
            .catch((cause) => process.emit("error", safeProcessError(cause)));
        });
        process.stdin.once("end", () => {
          if (!process.killed) {
            void sandbox.process
              .sendSessionCommandInput(sessionId, started.cmdId, "\u0004")
              .catch((cause) => process.emit("error", safeProcessError(cause)));
          }
        });
        process.setKillHandler(async () => {
          await sandbox.process.deleteSession(sessionId);
          return true;
        });
        void sandbox.process
          .getSessionCommandLogs(
            sessionId,
            started.cmdId,
            (chunk) => process.stdout.write(chunk),
            (chunk) => process.stderr.write(chunk),
          )
          .then(() => sandbox.process.getSessionCommand(sessionId, started.cmdId))
          .then((result) => process.complete(result.exitCode))
          .catch(async (cause) => {
            await sandbox.process.deleteSession(sessionId).catch(() => undefined);
            process.emit("error", safeProcessError(cause));
            process.complete(null, "SIGKILL");
          })
          .finally(async () => {
            await cleanupEnvironment?.();
            await close();
          });
        return process;
      } catch (cause) {
        await cleanupEnvironment?.();
        await close();
        throw cause;
      }
    },
    action: async (sandboxId, action) => {
      const daytona = await load();
      try {
        const sandbox = await daytona.get(sandboxId);
        switch (action) {
          case "pause":
            await sandbox.pause();
            return;
          case "resume":
            await sandbox.start();
            return;
          case "stop":
            await sandbox.stop();
            return;
          case "delete":
            await daytona.delete(sandbox, 60, true);
        }
      } finally {
        await daytona.close();
      }
    },
    uploadFile: async (sandboxId, remotePath, data) => {
      const daytona = await load();
      try {
        const sandbox = await daytona.get(sandboxId);
        await sandbox.fs.uploadFile(Buffer.from(data), remotePath);
      } finally {
        await daytona.close();
      }
    },
    downloadFile: async (sandboxId, remotePath) => {
      const daytona = await load();
      try {
        const sandbox = await daytona.get(sandboxId);
        return await sandbox.fs.downloadFile(remotePath);
      } finally {
        await daytona.close();
      }
    },
  };
};
