import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class PtySpawnError extends Schema.TaggedError<PtySpawnError>()("PtySpawnError", {
  adapter: Schema.String,
  shell: Schema.optional(Schema.String),
  attemptedShells: Schema.optional(Schema.Array(Schema.String)),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    const shell = this.shell === undefined ? "" : ` '${this.shell}'`;
    const attemptedShells =
      this.attemptedShells === undefined || this.attemptedShells.length === 0
        ? ""
        : ` Tried shells: ${this.attemptedShells.join(", ")}.`;
    return `Failed to spawn PTY process${shell} with ${this.adapter}.${attemptedShells}`;
  }
}

export interface PtyExitEvent {
  exitCode: number;
  signal: number | null;
}

export interface PtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(callback: (data: string) => void): () => void;
  onExit(callback: (event: PtyExitEvent) => void): () => void;
}

export interface PtySpawnInput {
  shell: string;
  args?: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

/**
 * PtyAdapter - Service tag for PTY process integration.
 *
 * A reference rather than a required service: deployments without a terminal
 * PTY (a cloud-hosted server, or a build without node-pty) keep a default that
 * fails cleanly instead of failing to boot the layer graph.
 */
export interface PtyAdapterService {
  /**
   * Spawn a PTY process for a terminal session.
   */
  readonly spawn: (input: PtySpawnInput) => Effect.Effect<PtyProcess, PtySpawnError>;
}

const unavailablePtyAdapter: PtyAdapterService = {
  spawn: (input) =>
    Effect.fail(
      new PtySpawnError({
        adapter: "unavailable",
        shell: input.shell,
      }),
    ),
};

export class PtyAdapter extends Context.Reference<PtyAdapterService>("@t3tools/shared/PtyAdapter", {
  defaultValue: () => unavailablePtyAdapter,
}) {}
