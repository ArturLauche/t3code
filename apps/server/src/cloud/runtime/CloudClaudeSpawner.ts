/**
 * Claude-specific bridge from the cloud execution transport to the Claude
 * Agent SDK's synchronous spawn hook.
 *
 * The SDK never asks a spawner for a handle; it calls `spawnClaudeCodeProcess`
 * and expects a `SpawnedProcess` synchronously. `DeferredCloudExecutionProcess` supplies
 * that shape while the remote start resolves asynchronously.
 *
 * @module cloud/runtime/CloudClaudeSpawner
 */
// @effect-diagnostics nodeBuiltinImport:off - Bridges the Claude Agent SDK's
// synchronous spawn hook to the cloud transport; both boundaries are Node streams.
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";

import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";

import type {
  CloudExecutionProcess,
  CloudSpawnNode,
} from "@t3tools/provider-core/server/cloudExecution";
class DeferredCloudExecutionProcess extends NodeEvents.EventEmitter implements SpawnedProcess {
  readonly stdin = new NodeStream.PassThrough();
  readonly stdout = new NodeStream.PassThrough();
  readonly stderr = new NodeStream.PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  private remote: CloudExecutionProcess | undefined;
  private pendingInput: Array<Uint8Array> = [];
  private pendingInputClosed = false;
  private completed = false;

  constructor(
    start: Effect.Effect<CloudExecutionProcess, PlatformError.PlatformError, Scope.Scope>,
  ) {
    super();
    this.on("error", () => undefined);
    this.stdin.on("data", (data: Buffer) => {
      if (this.remote) {
        this.remote.stdin.write(data);
      } else {
        this.pendingInput.push(data);
      }
    });
    this.stdin.on("end", () => {
      this.pendingInputClosed = true;
      this.remote?.closeStdin();
    });
    void Effect.runPromise(Effect.scoped(start)).then(
      (remote) => {
        if (this.killed) {
          remote.kill("SIGTERM");
        }
        this.remote = remote;
        const finish = (code: number | null, signal: NodeJS.Signals | null) => {
          if (this.completed) return;
          this.completed = true;
          const normalizedCode = code ?? 1;
          this.exitCode = normalizedCode;
          this.signalCode = signal;
          this.stdin.end();
          this.stdout.end();
          this.stderr.end();
          this.emit("exit", normalizedCode, signal);
        };
        // Subscribe to the completion promise before forwarding streams. This
        // also catches a process that completed while the asynchronous start
        // effect was being resolved.
        void remote.wait().then(
          ({ exitCode, signal }) => finish(exitCode, signal),
          (error) => {
            this.emit("error", error instanceof Error ? error : new Error(String(error)));
            finish(1, null);
          },
        );
        remote.stdout.on("data", (data: Buffer) => this.stdout.write(data));
        remote.stderr.on("data", (data: Buffer) => this.stderr.write(data));
        remote.on("error", (error) => this.emit("error", error));
        for (const input of this.pendingInput) remote.stdin.write(input);
        this.pendingInput = [];
        if (this.pendingInputClosed) remote.closeStdin();
      },
      (error) => {
        this.emit("error", error instanceof Error ? error : new Error(String(error)));
        this.exitCode = 1;
        this.completed = true;
        this.stdin.end();
        this.stdout.end();
        this.stderr.end();
        this.emit("exit", 1, null);
      },
    );
  }

  kill(signal: NodeJS.Signals): boolean {
    if (this.killed) return false;
    this.killed = true;
    this.remote?.kill(signal);
    return true;
  }
}

/** Adapt the asynchronous cloud transport to Claude's synchronous spawn hook. */
export const makeCloudClaudeSpawner =
  (spawnNode: CloudSpawnNode): ((options: SpawnOptions) => SpawnedProcess) =>
  (options) => {
    const env = Object.fromEntries(
      Object.entries(options.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const command = ChildProcess.make(options.command, options.args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env,
    });
    const deferred = new DeferredCloudExecutionProcess(spawnNode(command));
    if (options.signal.aborted) deferred.kill("SIGTERM");
    else options.signal.addEventListener("abort", () => deferred.kill("SIGTERM"), { once: true });
    return deferred;
  };
