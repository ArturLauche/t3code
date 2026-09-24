import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

export interface CloudProcessExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * Node-compatible process surface backed by a cloud command. Protocol
 * clients use this through both Effect's ChildProcessSpawner and Claude's
 * SDK custom spawn hook, so the cloud transport stays below provider code.
 */
export class CloudProcess extends NodeEvents.EventEmitter {
  pid: number;

  // ChildProcess errors do not crash a server when a transport listener is
  // absent. Keep a default sink while still forwarding errors to SDK listeners.
  constructor(pid = 0) {
    super();
    this.pid = pid;
    this.on("error", () => undefined);
  }

  readonly stdin = new NodeStream.PassThrough();
  readonly stdout = new NodeStream.PassThrough();
  readonly stderr = new NodeStream.PassThrough();

  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  private _exitSignal: NodeJS.Signals | null = null;
  private completedFlag = false;
  private killHandler: ((signal: NodeJS.Signals) => Promise<boolean>) | null = null;
  private resizeHandler: ((cols: number, rows: number) => Promise<void>) | null = null;
  private readonly exited = new Promise<CloudProcessExit>((resolve) => {
    this.once("exit", (exitCode: number | null, signal: NodeJS.Signals | null) => {
      resolve({ exitCode, signal });
    });
  });

  write(data: string | Uint8Array): boolean {
    return this.stdin.write(data);
  }

  closeStdin(): void {
    this.stdin.end();
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.killed) return false;
    this.killed = true;
    if (this.killHandler) {
      void this.killHandler(signal).catch((cause) => this.emit("error", cause));
    }
    return true;
  }

  setKillHandler(handler: (signal: NodeJS.Signals) => Promise<boolean>): void {
    this.killHandler = handler;
  }

  setResizeHandler(handler: (cols: number, rows: number) => Promise<void>): void {
    this.resizeHandler = handler;
  }

  resize(cols: number, rows: number): void {
    if (this.completedFlag) return;
    if (this.resizeHandler) {
      void this.resizeHandler(cols, rows).catch((cause) => this.emit("error", cause));
    }
  }

  complete(exitCode: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.completedFlag) return;
    this.completedFlag = true;
    this.exitCode = exitCode;
    this.signalCode = signal;
    this._exitSignal = signal;
    this.stdin.end();
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", exitCode, signal);
  }

  asChildProcessHandle(): ChildProcessSpawner.ChildProcessHandle {
    const streamError = (cause: unknown) =>
      PlatformError.systemError({
        _tag: "Unknown",
        module: "CloudProcess",
        method: "stream",
        cause,
      });
    const stdout = Stream.fromAsyncIterable(this.stdout as AsyncIterable<Uint8Array>, streamError);
    const stderr = Stream.fromAsyncIterable(this.stderr as AsyncIterable<Uint8Array>, streamError);
    return ChildProcessSpawner.makeHandle({
      pid: this.pid as ChildProcessSpawner.ProcessId,
      exitCode: Effect.map(
        Effect.promise(() => this.wait()),
        (result) => (result.exitCode ?? 1) as ChildProcessSpawner.ExitCode,
      ),
      isRunning: Effect.sync(() => !this.completedFlag),
      kill: (options) =>
        Effect.sync(() => {
          this.kill(options?.killSignal);
        }),
      unref: Effect.succeed(Effect.void),
      stdin: Sink.forEach((chunk: Uint8Array) =>
        Effect.sync(() => {
          this.stdin.write(chunk);
        }),
      ),
      stdout,
      stderr,
      all: Stream.merge(stdout, stderr),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    });
  }

  wait(): Promise<CloudProcessExit> {
    return this.exited;
  }

  get completed(): boolean {
    return this.completedFlag;
  }

  get exitSignal(): NodeJS.Signals | null {
    return this._exitSignal;
  }
}
