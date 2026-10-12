/**
 * The slice of a remote-execution runtime that a provider driver can reach.
 *
 * Fork addition: the server owns the concrete cloud runtime implementation
 * (sandbox vendors, credential rotation, sandbox retirement), which cannot be
 * imported from a package. This module declares only the capability a driver
 * needs — prepare a workspace once, then start processes inside it — so the
 * driver SPI stays portable while the server keeps the real service.
 *
 * The implementation lives in `@t3tools/cloud-runtime`; its
 * `CloudRuntimeServiceShape` and the transport built by
 * `makeCloudExecutionSpawner` are structurally assignable to these types.
 *
 * @module provider-core/server/cloudExecution
 */
import type { CloudExecutionHandle, CloudRuntimeError, CloudRuntimeId } from "@t3tools/contracts";
import type * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";

/** A command started inside a sandbox, with the PTY geometry when relevant. */
export interface CloudExecutionCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutSeconds: number;
  readonly pty?: CloudPtyOptions;
}

/** PTY geometry for a command that runs under a real terminal. */
export interface CloudPtyOptions {
  readonly cols: number;
  readonly rows: number;
}

/**
 * Stream- and lifetime-shaped handle over a process running in a sandbox. The
 * server returns a richer class instance; this is the surface the cloud
 * execution transport in the fork reads.
 */
export interface CloudExecutionProcess extends NodeJS.EventEmitter {
  readonly pid: number;
  readonly stdin: NodeJS.WritableStream & NodeJS.ReadableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  readonly killed: boolean;
  readonly completed: boolean;
  readonly exitCode: number | null;
  write(data: string | Uint8Array): boolean;
  closeStdin(): void;
  kill(signal?: string): boolean;
  resize(cols: number, rows: number): void;
  complete(exitCode: number | null, signal?: string | null): void;
  asChildProcessHandle(): ChildProcessSpawner.ChildProcessHandle;
  wait(): Promise<{ readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }>;
}

/**
 * Maps a local workspace path to its cloud-sandbox counterpart. Provider
 * protocol messages carry local paths, so adapters translate the ones that
 * travel to the remote runtime.
 */
export type CloudExecutionCwdResolver = (cwd: string) => string | undefined;

/** Starts one process in a sandbox, optionally under a PTY. */
export type CloudSpawnNode = (
  command: ChildProcess.Command,
  pty?: CloudPtyOptions,
) => Effect.Effect<CloudExecutionProcess, PlatformError.PlatformError, Scope.Scope>;

export interface CloudExecutionPrepareInput {
  readonly runtimeId: CloudRuntimeId;
  readonly name: string;
  readonly metadata?: Readonly<Record<string, string>>;
  /** Optional workspace archive uploaded before setup commands run. */
  readonly workspaceArchive?: Uint8Array;
}

export interface CloudExecutionRuntime {
  /** Prepare a reusable sandbox and run the runtime's setup commands once per preparation. */
  readonly prepareExecution: (
    input: CloudExecutionPrepareInput,
  ) => Effect.Effect<CloudExecutionHandle, CloudRuntimeError>;
  readonly startProcess: (
    runtimeId: CloudRuntimeId,
    sandboxId: string,
    command: CloudExecutionCommand,
  ) => Effect.Effect<CloudExecutionProcess, CloudRuntimeError>;
}

/**
 * How a provider driver runs its agent when the instance points at a cloud
 * sandbox instead of the local machine.
 *
 * Drivers build this once per instance (see `makeCloudExecutionSpawner`) and
 * hand it to the orchestration adapter, which needs exactly two things: a
 * spawner that launches inside the sandbox, and the mapping from a local
 * workspace path to its remote counterpart for the paths that travel in
 * provider protocol messages.
 */
export interface CloudExecutionTransport {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly remoteCwdFor: CloudExecutionCwdResolver;
  /**
   * Starts one process in the sandbox under a PTY. Adapters whose SDK owns
   * process creation (the Claude Agent SDK) spawn through this instead of
   * `spawner`, because the SDK never asks a spawner for a handle.
   */
  readonly spawnNode: CloudSpawnNode;
}
