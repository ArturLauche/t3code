import { describe, expect, it } from "@effect/vitest";
import { FreebuffSettings, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as PtyAdapter from "../../terminal/PtyAdapter.ts";
import { makeFreebuffAdapter, extractVisibleAssistantText } from "./FreebuffAdapter.ts";

class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly pid = 4242;
  readonly writes: string[] = [];
  killed = false;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();

  write(data: string): void {
    this.writes.push(data);
  }

  resize(): void {}

  kill(): void {
    this.killed = true;
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }
}

const settings = Schema.decodeSync(FreebuffSettings)({
  enabled: true,
  binaryPath: "/opt/freebuff",
  configDir: "/tmp/freebuff-test",
  launchArgs: "--trust-agents",
});

const instanceId = ProviderInstanceId.make("freebuff-test");
const threadId = ThreadId.make("freebuff-thread");

describe("FreebuffAdapter", () => {
  it.effect("starts the official CLI with an isolated config directory", () =>
    Effect.gen(function* () {
      const process = new FakePtyProcess();
      const spawnInputs: PtyAdapter.PtySpawnInput[] = [];
      const adapter = yield* makeFreebuffAdapter({
        settings,
        configDir: "/tmp/freebuff-test",
        environment: {},
        instanceId,
        defaultCwd: "/workspace/project",
      }).pipe(
        Effect.provideService(PtyAdapter.PtyAdapter, {
          spawn: (input) => {
            spawnInputs.push(input);
            return Effect.succeed(process);
          },
        }),
        Effect.scoped,
      );

      const session = yield* adapter.startSession({
        threadId,
        cwd: "/workspace/project",
        runtimeMode: "full-access",
      });

      expect(session.provider).toBe("freebuff");
      expect(session.status).toBe("ready");
      expect(spawnInputs).toHaveLength(1);
      expect(spawnInputs[0]?.shell).toBe("/opt/freebuff");
      expect(spawnInputs[0]?.args).toEqual(["--trust-agents", "--cwd", "/workspace/project"]);
      expect(spawnInputs[0]?.env.FREEBUFF_CONFIG_DIR).toBe("/tmp/freebuff-test");
      expect(spawnInputs[0]?.env.TERM).toBe("xterm-256color");

      yield* adapter.stopSession(threadId);
      expect(process.killed).toBe(true);
    }),
  );

  it.effect("rejects runtime modes that the terminal bridge cannot enforce", () =>
    Effect.gen(function* () {
      const adapter = yield* makeFreebuffAdapter({
        settings,
        configDir: "/tmp/freebuff-test",
        environment: {},
        instanceId,
        defaultCwd: "/workspace/project",
      }).pipe(
        Effect.provideService(PtyAdapter.PtyAdapter, {
          spawn: () => Effect.die("PTY should not start for an invalid mode."),
        }),
        Effect.scoped,
      );

      const error = yield* Effect.flip(
        adapter.startSession({
          threadId,
          runtimeMode: "approval-required",
        }),
      );
      expect(error.message).toMatch(/only full-access/);
    }),
  );

  it("extracts assistant text from the visible terminal region", () => {
    expect(
      extractVisibleAssistantText({
        baseline: "Freebuff\n> ",
        current: "Freebuff\n> hello\nassistant response\n? for shortcuts",
        prompt: "hello",
      }),
    ).toBe("assistant response");
  });
});
