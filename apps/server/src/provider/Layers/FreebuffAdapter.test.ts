import { describe, expect, it } from "@effect/vitest";
import {
  FREEBUFF_DEFAULT_MODEL,
  FreebuffSettings,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as PtyAdapter from "../../terminal/PtyAdapter.ts";
import {
  classifyFreebuffScreen,
  extractVisibleAssistantText,
  makeFreebuffAdapter,
  mergeVisibleAssistantText,
} from "./FreebuffAdapter.ts";

class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly pid = 4242;
  readonly writes: string[] = [];
  readonly killSignals: string[] = [];
  killed = false;
  failWrites = false;
  failKills = false;
  exitOnTerm = true;
  private exited = false;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  private readonly writeWaiters = new Set<{
    count: number;
    resume: (effect: Effect.Effect<void>) => void;
  }>();
  private readonly killWaiters = new Set<{
    count: number;
    resume: (effect: Effect.Effect<void>) => void;
  }>();

  write(data: string): void {
    if (this.failWrites) throw new Error("write failed");
    this.writes.push(data);
    for (const waiter of this.writeWaiters) {
      if (this.writes.length >= waiter.count) {
        this.writeWaiters.delete(waiter);
        waiter.resume(Effect.void);
      }
    }
  }

  resize(): void {}

  kill(signal = "SIGTERM"): void {
    if (this.failKills) throw new Error("kill failed");
    this.killed = true;
    this.killSignals.push(signal);
    for (const waiter of this.killWaiters) {
      if (this.killSignals.length >= waiter.count) {
        this.killWaiters.delete(waiter);
        waiter.resume(Effect.void);
      }
    }
    if (!this.exited && (signal === "SIGKILL" || this.exitOnTerm)) {
      this.emitExit({ exitCode: 0, signal: null });
    }
  }

  onData(callback: (data: string) => void): () => void {
    this.dataListeners.add(callback);
    return () => this.dataListeners.delete(callback);
  }

  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(event: PtyAdapter.PtyExitEvent = { exitCode: 1, signal: null }): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener(event);
  }

  waitForWrites(count: number): Effect.Effect<void> {
    if (this.writes.length >= count) return Effect.void;
    return Effect.callback<void, never>((resume) => {
      const waiter = { count, resume };
      this.writeWaiters.add(waiter);
      return Effect.sync(() => this.writeWaiters.delete(waiter));
    });
  }

  waitForKills(count: number): Effect.Effect<void> {
    if (this.killSignals.length >= count) return Effect.void;
    return Effect.callback<void, never>((resume) => {
      const waiter = { count, resume };
      this.killWaiters.add(waiter);
      return Effect.sync(() => this.killWaiters.delete(waiter));
    });
  }
}

const decodeSettings = Schema.decodeSync(FreebuffSettings);
const instanceId = ProviderInstanceId.make("freebuff-test");
const threadId = ThreadId.make("freebuff-thread");
const otherThreadId = ThreadId.make("freebuff-other-thread");
const settings = decodeSettings({
  enabled: true,
  binaryPath: "/opt/freebuff",
  configDir: "/tmp/freebuff-test",
  launchArgs: "",
});

const waitForActiveTurn = (adapter: {
  readonly listSessions: () => Effect.Effect<
    ReadonlyArray<{ readonly activeTurnId?: string | undefined }>,
    never,
    never
  >;
}) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const sessions = yield* adapter.listSessions();
      if (sessions.some((session) => session.activeTurnId !== undefined)) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die("The test turn did not become active.");
  });

const makeAdapter = (
  process: FakePtyProcess,
  overrides?: Partial<Parameters<typeof decodeSettings>[0]>,
) =>
  makeFreebuffAdapter({
    settings: decodeSettings({
      enabled: true,
      binaryPath: "/opt/freebuff",
      configDir: "/tmp/freebuff-test",
      launchArgs: "",
      ...overrides,
    }),
    configDir: "/tmp/freebuff-test",
    environment: {},
    instanceId,
    defaultCwd: "/workspace/project",
  }).pipe(
    Effect.provideService(PtyAdapter.PtyAdapter, {
      spawn: () => Effect.succeed(process),
    }),
  );

describe("Freebuff screen classification", () => {
  it("recognizes current Freebuff gates without matching assistant prose in chat", () => {
    expect(classifyFreebuffScreen("Press ENTER to login...").kind).toBe("authentication");
    expect(classifyFreebuffScreen("Start coding for free\nGLM 5.3 Flash").kind).toBe("landing");
    expect(classifyFreebuffScreen("Freebuff is already running\nTake over").kind).toBe("blocked");
    expect(
      classifyFreebuffScreen(
        "Another freebuff instance took over this account.\nOnly one CLI per account can be active at a time.\nClose the other instance, then restart freebuff here.",
      ).kind,
    ).toBe("blocked");
    expect(
      classifyFreebuffScreen(
        "freebuff found agent files in this repository it has not run before:\n  /workspace/project/.agents\nLoad and run these? [y/N]",
      ).kind,
    ).toBe("blocked");
    expect(classifyFreebuffScreen("thinking...\nEnter a coding task or / for commands").kind).toBe(
      "busy",
    );
    expect(
      classifyFreebuffScreen("Freebuff is already running\nEnter a coding task or / for commands")
        .kind,
    ).toBe("blocked");
    expect(
      classifyFreebuffScreen(
        `Start coding for free\n${Array.from({ length: 130 }, () => "historical output").join("\n")}\nEnter a coding task or / for commands`,
      ).kind,
    ).toBe("chat");
    expect(
      classifyFreebuffScreen(
        `login required\n${Array.from({ length: 130 }, () => "historical output").join("\n")}\nEnter a coding task or / for commands`,
      ).kind,
    ).toBe("chat");
    expect(classifyFreebuffScreen("loading...").kind).toBe("busy");
    expect(
      classifyFreebuffScreen(
        "╭────────────╮\n│ thinking... 2s ■ Esc │\n│ Enter a coding task │\n╰────────────╯",
      ).kind,
    ).toBe("busy");
    expect(
      classifyFreebuffScreen("thinking... 2s ■ Esc\nEnter a coding task or / for commands").kind,
    ).toBe("busy");
  });
});

describe("extractVisibleAssistantText", () => {
  it("removes bordered composer chrome from visible output", () => {
    expect(
      extractVisibleAssistantText({
        baseline: "╭────────────╮\n│ Enter a coding task │\n╰────────────╯",
        current:
          "╭────────────╮\n│ Enter a coding task │\n│ > Explain │\n│ answer │\n╰────────────╯",
        prompt: "Explain",
      }),
    ).toBe("answer");
  });

  it("preserves Markdown delimiters while removing composer borders", () => {
    expect(
      extractVisibleAssistantText({
        baseline: "Enter a coding task or / for commands",
        current: "Enter a coding task or / for commands\n> Explain\n│ `code` │\n│ | a | b | │",
        prompt: "Explain",
      }),
    ).toBe("`code`\n| a | b |");
  });

  it("anchors extraction at the end of a wrapped user prompt", () => {
    expect(
      extractVisibleAssistantText({
        baseline: "Enter a coding task or / for commands",
        current:
          "Enter a coding task or / for commands\n> This is a long user prompt that wraps\n  continuation line\nanswer",
        prompt: "This is a long user prompt that wraps\ncontinuation line",
      }),
    ).toBe("answer");
  });

  it("anchors extraction at the newest timestamped user bubble", () => {
    expect(
      extractVisibleAssistantText({
        baseline: "[09:41]\ntest\nold answer",
        current:
          "[09:41]\ntest\nold answer\n[09:42]\ntest\nThis is a test\nFreebuff will run commands on your behalf to help you build.",
        prompt: "test",
      }),
    ).toBe("This is a test");
  });

  it("finds a wrapped prompt inside a timestamped user bubble", () => {
    expect(
      extractVisibleAssistantText({
        baseline: "Freebuff",
        current:
          "Freebuff\n[09:42]\nThis is a long user prompt that wraps\ncontinuation line\nanswer",
        prompt: "This is a long user prompt that wraps\ncontinuation line",
      }),
    ).toBe("answer");
  });

  it("anchors extraction at the user prompt when the answer repeats it", () => {
    expect(
      extractVisibleAssistantText({
        baseline: "Enter a coding task or / for commands",
        current: "Enter a coding task or / for commands\n> test\nThis is a test",
        prompt: "test",
      }),
    ).toBe("This is a test");
  });

  it("anchors repeated non-timestamped prompts at the newest turn", () => {
    expect(
      extractVisibleAssistantText({
        baseline: "Enter a coding task or / for commands\n> Explain\nold answer",
        current:
          "Enter a coding task or / for commands\n> Explain\nold answer\n> Explain\nnew answer\nEnter a coding task or / for commands",
        prompt: "Explain",
      }),
    ).toBe("new answer");
  });

  it("does not treat a prompt-only screen as assistant output", () => {
    expect(
      extractVisibleAssistantText({
        baseline: "Enter a coding task or / for commands",
        current:
          "Enter a coding task or / for commands\n> Explain\nEnter a coding task or / for commands",
        prompt: "Explain",
      }),
    ).toBe("");
  });

  it("merges overlapping terminal snapshots without duplicating scrolled lines", () => {
    expect(mergeVisibleAssistantText("line 1\nline 2", "line 2\nline 3")).toBe(
      "line 1\nline 2\nline 3",
    );
    expect(mergeVisibleAssistantText("line 1", "line 1")).toBe("line 1");
  });

  it("strips echoed attachment context from assistant output", () => {
    expect(
      extractVisibleAssistantText({
        baseline: "Enter a coding task or / for commands",
        current:
          'Enter a coding task or / for commands\n> Explain\n[Attached file "notes.txt" is saved at: /tmp/notes.txt]\nanswer',
        prompt: "Explain",
      }),
    ).toBe("answer");
  });

  it("strips echoed runtime instructions from assistant output", () => {
    expect(
      extractVisibleAssistantText({
        baseline: "Enter a coding task or / for commands",
        current:
          "Enter a coding task or / for commands\n> Explain\n<runtime_info>\ninternal context\n</runtime_info>\nanswer",
        prompt: "Explain",
      }),
    ).toBe("answer");
  });

  it("keeps repeated output and blank lines after the submitted prompt", () => {
    expect(
      extractVisibleAssistantText({
        baseline: "Freebuff\n> Explain",
        current:
          "Freebuff\n> Explain\n\nrepeated line\n\nrepeated line\n\nEnter a coding task or / for commands",
        prompt: "Explain",
      }),
    ).toBe("repeated line\n\nrepeated line");
  });
});

describe("FreebuffAdapter", () => {
  it.live("starts local-only without implicitly trusting repository agents", () =>
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
      );

      const session = yield* adapter.startSession({
        threadId,
        cwd: "/workspace/project",
        modelSelection: { instanceId, model: FREEBUFF_DEFAULT_MODEL },
        runtimeMode: "full-access",
      });

      expect(session.provider).toBe("freebuff");
      expect(session.model).toBe(FREEBUFF_DEFAULT_MODEL);
      expect(session.status).toBe("ready");

      expect(session.resumeCursor).toBeUndefined();
      expect(spawnInputs).toHaveLength(1);
      expect(spawnInputs[0]?.shell).toBe("/opt/freebuff");
      expect(spawnInputs[0]?.args).toEqual(["--cwd", "/workspace/project"]);
      expect(spawnInputs[0]?.env.FREEBUFF_CONFIG_DIR).toBe("/tmp/freebuff-test");

      yield* adapter.stopSession(threadId);
      expect(process.killSignals).toEqual(["SIGTERM"]);
    }),
  );

  it.live("adds the trust flag only after explicit opt-in", () =>
    Effect.gen(function* () {
      const process = new FakePtyProcess();
      const spawnInputs: PtyAdapter.PtySpawnInput[] = [];
      const adapter = yield* makeFreebuffAdapter({
        settings: decodeSettings({
          enabled: true,
          binaryPath: "/opt/freebuff",
          configDir: "/tmp/freebuff-test",
          launchArgs: "--some-option",
          trustRepositoryAgents: true,
        }),
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
      );

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      expect(spawnInputs[0]?.args).toEqual([
        "--some-option",
        "--trust-agents",
        "--cwd",
        "/workspace/project",
      ]);
    }),
  );

  it.live("rejects restricted runtime and unsupported plan semantics", () =>
    Effect.gen(function* () {
      const process = new FakePtyProcess();
      const adapter = yield* makeAdapter(process);
      const runtimeError = yield* Effect.flip(
        adapter.startSession({ threadId, runtimeMode: "approval-required" }),
      );
      expect(runtimeError.message).toMatch(/only full-access/);

      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const planError = yield* Effect.flip(
        adapter.sendTurn({ threadId, input: "Plan this", interactionMode: "plan" }),
      );
      expect(planError.message).toMatch(/does not expose a separate plan mode/);
    }),
  );

  it.live("admits the landing screen only after a turn, then submits to the chat screen", () =>
    Effect.gen(function* () {
      const process = new FakePtyProcess();
      const adapter = yield* makeAdapter(process);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const send = yield* adapter
        .sendTurn({ threadId, input: "Make this reliable" })
        .pipe(Effect.forkChild);
      yield* waitForActiveTurn(adapter);

      process.emitData("Start coding for free\nWelcome — press any key to continue");

      yield* process.waitForWrites(1);
      expect(process.writes[0]).toBe("\r");

      process.emitData("Start coding for free\nGLM 5.3 Flash");
      yield* process.waitForWrites(2);
      expect(process.writes[1]).toBe("\r");

      process.emitData("Enter a coding task or / for commands\n? for shortcuts");
      const result = yield* Fiber.join(send);
      expect(result.resumeCursor).toBeNull();
      expect(process.writes[2]).toContain("Make this reliable");
      expect(process.writes[2]).toContain("through the Freebuff harness");
      expect(process.writes[2]).not.toContain("freebuff-default");
      expect(process.writes[2]).not.toContain("link_pull_request");
      const history = yield* adapter.readThread(threadId);
      expect(history.turns[0]?.items[0]).toEqual({
        type: "user_message",
        text: "Make this reliable",
      });
      yield* adapter.stopSession(threadId);
    }),
  );

  it.live("does not harvest a takeover screen as assistant output", () =>
    Effect.gen(function* () {
      const process = new FakePtyProcess();
      const adapter = yield* makeAdapter(process);
      const events = yield* adapter.streamEvents.pipe(
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const send = yield* adapter.sendTurn({ threadId, input: "Hello" }).pipe(Effect.forkChild);
      yield* waitForActiveTurn(adapter);
      process.emitData("Enter a coding task or / for commands");
      yield* Fiber.join(send);
      process.emitData(
        "Another freebuff instance took over this account.\nOnly one CLI per account can be active at a time.\nClose the other instance, then restart freebuff here.",
      );

      const collected = yield* Fiber.join(events);
      const completed = collected.find((event) => event.type === "turn.completed");
      expect(completed?.payload).toMatchObject({
        state: "failed",
        errorMessage: expect.stringMatching(/took over this account/iu),
      });
      expect(
        collected.some(
          (event) =>
            event.type === "content.delta" &&
            event.payload.delta.includes("Another freebuff instance took over"),
        ),
      ).toBe(false);
    }),
  );

  it.live("fails a turn before touching a login screen", () =>
    Effect.gen(function* () {
      const process = new FakePtyProcess();
      const adapter = yield* makeAdapter(process);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      process.emitData("Codebuff\nPress ENTER to login...");
      const error = yield* Effect.flip(adapter.sendTurn({ threadId, input: "Hello" }));

      expect(error.message).toMatch(/not authenticated/);
      expect(process.writes).toEqual([]);
    }),
  );

  it.live("fails before touching a repository-agent trust prompt", () =>
    Effect.gen(function* () {
      const process = new FakePtyProcess();
      const adapter = yield* makeAdapter(process);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      process.emitData(
        "freebuff found agent files in this repository it has not run before:\n  /workspace/project/.agents\nLoad and run these? [y/N]",
      );
      const error = yield* Effect.flip(adapter.sendTurn({ threadId, input: "Hello" }));

      expect(error.message).toMatch(/needs approval before loading repository/);
      expect(process.writes).toEqual([]);
    }),
  );

  it.live("returns prompt write failures to the caller", () =>
    Effect.gen(function* () {
      const process = new FakePtyProcess();
      const adapter = yield* makeAdapter(process);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      process.failWrites = true;
      const send = yield* adapter.sendTurn({ threadId, input: "Hello" }).pipe(Effect.forkChild);
      yield* waitForActiveTurn(adapter);
      process.emitData("Enter a coding task or / for commands");
      const error = yield* Effect.flip(Fiber.join(send));

      expect(error.message).toMatch(/Failed to write the prompt/);
      expect(yield* adapter.hasSession(threadId)).toBe(true);
    }),
  );

  it.live("enforces one active Freebuff process per provider instance", () =>
    Effect.gen(function* () {
      const process = new FakePtyProcess();
      const adapter = yield* makeAdapter(process);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const error = yield* Effect.flip(
        adapter.startSession({ threadId: otherThreadId, runtimeMode: "full-access" }),
      );
      expect(error.message).toMatch(/one active session/);
    }),
  );

  it.live("keeps a failed stop reserved until cleanup can be retried", () =>
    Effect.gen(function* () {
      const process = new FakePtyProcess();
      process.failKills = true;
      const adapter = yield* makeAdapter(process);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      const stopError = yield* Effect.flip(adapter.stopSession(threadId));
      expect(stopError.message).toMatch(/Failed to stop/);
      expect(yield* adapter.hasSession(threadId)).toBe(true);
      const startError = yield* Effect.flip(
        adapter.startSession({ threadId: otherThreadId, runtimeMode: "full-access" }),
      );
      expect(startError.message).toMatch(/one active session/);

      process.failKills = false;
      yield* adapter.stopSession(threadId);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
    }),
  );

  it.live("shares an in-flight stop result with concurrent callers", () =>
    Effect.gen(function* () {
      const process = new FakePtyProcess();
      process.exitOnTerm = false;
      const adapter = yield* makeAdapter(process);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });

      const first = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
      yield* process.waitForKills(1);
      const second = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      process.emitExit({ exitCode: 0, signal: null });

      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
    }),
  );

  it.live("clears the legacy terminal-bridge cursor instead of claiming resume support", () =>
    Effect.gen(function* () {
      const process = new FakePtyProcess();
      const adapter = yield* makeAdapter(process);
      const session = yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, configDir: "/tmp/freebuff-test" },
      });
      expect(session.resumeCursor).toBeNull();
    }),
  );

  it.live("scopes interrupts to the active provider turn", () =>
    Effect.gen(function* () {
      const process = new FakePtyProcess();
      const adapter = yield* makeAdapter(process);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const send = yield* adapter.sendTurn({ threadId, input: "Hello" }).pipe(Effect.forkChild);
      yield* waitForActiveTurn(adapter);
      process.emitData("Enter a coding task or / for commands");
      const turn = yield* Fiber.join(send);

      const before = process.writes.length;
      yield* adapter.interruptTurn(threadId, TurnId.make("another-turn"));
      expect(process.writes).toHaveLength(before);
      yield* adapter.interruptTurn(threadId, turn.turnId);
      expect(process.writes.at(-1)).toBe("\u001b");
    }),
  );

  it.live("publishes unexpected exits as non-recoverable", () =>
    Effect.gen(function* () {
      const process = new FakePtyProcess();
      const adapter = yield* makeAdapter(process);
      const exits = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.type === "session.exited"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.sleep("10 millis");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      process.emitExit({ exitCode: 1, signal: null });

      const [event] = yield* Fiber.join(exits);
      expect(event).toMatchObject({
        type: "session.exited",
        payload: { recoverable: false, exitKind: "error" },
      });
      expect(yield* adapter.hasSession(threadId)).toBe(false);
    }),
  );
});
