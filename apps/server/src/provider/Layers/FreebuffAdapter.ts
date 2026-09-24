import * as NodeCrypto from "node:crypto";
import XtermHeadless from "@xterm/headless";
import {
  EventId,
  type FreebuffSettings,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { expandHomePath } from "../../pathExpansion.ts";
import * as PtyAdapter from "../../terminal/PtyAdapter.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { FREEBUFF_PROVIDER } from "./FreebuffProvider.ts";

type XtermTerminal = import("@xterm/headless").Terminal;
const { Terminal } = XtermHeadless as unknown as {
  readonly Terminal: typeof import("@xterm/headless").Terminal;
};

const TURN_SETTLE_MS = 2_500;
const TERMINAL_COLUMNS = 160;
const TERMINAL_ROWS = 48;
const MAX_VISIBLE_TEXT_LENGTH = 200_000;

type FreebuffProcessEvent =
  | { readonly type: "screen"; readonly value: string }
  | { readonly type: "exit"; readonly exitCode: number };

interface ActiveTerminalTurn {
  readonly id: TurnId;
  readonly itemId: RuntimeItemId;
  readonly prompt: string;
  readonly baseline: string;
  latestScreen: string;
  submitted: boolean;
  abortRequested: boolean;
}

interface FreebuffThreadTurn {
  readonly id: TurnId;
  readonly prompt: string;
  output?: string;
}

interface FreebuffSessionContext {
  readonly threadId: ThreadId;
  readonly process: PtyAdapter.PtyProcess;
  readonly processEvents: Queue.Queue<FreebuffProcessEvent>;
  readonly terminal: XtermTerminal;
  readonly configDir: string;
  readonly scope: Scope.Closeable;
  session: ProviderSession;
  readonly turns: Array<FreebuffThreadTurn>;
  readonly activeTurn: Ref.Ref<ActiveTerminalTurn | undefined>;
  readonly lastScreen: Ref.Ref<string>;
  monitorFiber?: Fiber.Fiber<void, never>;
  readonly disposeTransport: () => void;
  stopped: boolean;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const terminalText = (terminal: XtermTerminal): string => {
  const buffer = terminal.buffer.active;
  const lines: Array<string> = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return lines.join("\n").trimEnd();
};

const requiresAuthentication = (screen: string): boolean =>
  /\b(?:not authenticated|authentication required|login required)\b/i.test(screen);

const isBusyScreen = (screen: string): boolean =>
  /\b(?:connecting|starting|loading|downloading|synchronizing)\b/i.test(screen);

const promptNeedle = (prompt: string): string =>
  (prompt.split(/\r?\n/u).find((line) => line.trim()) ?? prompt).trim().slice(0, 80);

const isTerminalChrome = (line: string): boolean => {
  const trimmed = line.trim();
  if (!trimmed) return true;
  return [
    /^codebuff(?:hq)?\b/iu,
    /^freebuff\b/iu,
    /^(?:working|thinking|running|waiting|connecting|starting|loading|downloading)(?:\.{3}|…)?$/iu,
    /^(?:press )?esc(?:ape)?(?: to)? (?:interrupt|stop)/iu,
    /^\? (?:for )?(?:shortcuts|help)/iu,
    /^(?:model|context|branch|tokens?)\s*[:•]/iu,
    /^(?:cwd|directory)\s*[:•]/iu,
  ].some((pattern) => pattern.test(trimmed));
};

export const extractVisibleAssistantText = (input: {
  readonly baseline: string;
  readonly current: string;
  readonly prompt: string;
}): string => {
  const currentLines = input.current.split("\n");
  const needle = promptNeedle(input.prompt);
  let promptIndex = -1;
  for (let index = currentLines.length - 1; index >= 0; index -= 1) {
    if (currentLines[index]?.includes(needle)) {
      promptIndex = index;
      break;
    }
  }

  let candidateLines: ReadonlyArray<string>;
  if (promptIndex >= 0) {
    candidateLines = currentLines.slice(promptIndex + 1);
  } else {
    const baselineLines = new Set(input.baseline.split("\n"));
    candidateLines = currentLines.filter((line) => !baselineLines.has(line));
  }

  const text = candidateLines
    .filter((line) => !isTerminalChrome(line))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return text.slice(0, MAX_VISIBLE_TEXT_LENGTH);
};

const encodePrompt = (prompt: string, bracketedPaste: boolean): string => {
  if (bracketedPaste) return `\u001b[200~${prompt}\u001b[201~\r`;
  // A non-bracketed TUI may submit on every newline. Preserve the words while
  // making the single T3 turn atomic from the terminal's perspective.
  return `${prompt.replaceAll(/\r?\n/gu, " ")}\r`;
};

class FreebuffTerminalProcessError extends Error {
  readonly operation: "write" | "kill";

  constructor(operation: "write" | "kill", cause: unknown) {
    super(`Freebuff terminal ${operation} failed.`);
    this.name = "FreebuffTerminalProcessError";
    this.operation = operation;
    this.cause = cause;
  }
}

const tryWriteProcess = (process: PtyAdapter.PtyProcess, data: string) =>
  Effect.try({
    try: () => {
      process.write(data);
    },
    catch: (cause) => new FreebuffTerminalProcessError("write", cause),
  });

const tryKillProcess = (process: PtyAdapter.PtyProcess) =>
  Effect.try({
    try: () => {
      process.kill("SIGTERM");
    },
    catch: (cause) => new FreebuffTerminalProcessError("kill", cause),
  });

const unsupportedInteraction = (method: string) =>
  Effect.fail(
    new ProviderAdapterRequestError({
      provider: FREEBUFF_PROVIDER,
      method,
      detail: "Freebuff's terminal bridge does not expose structured interactive requests to T3.",
    }),
  );

export const makeFreebuffAdapter = Effect.fn("makeFreebuffAdapter")(function* (input: {
  readonly settings: FreebuffSettings;
  readonly configDir: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly instanceId: ProviderInstanceId;
  readonly defaultCwd: string;
  readonly ptyAdapter?: PtyAdapter.PtyAdapterService;
}) {
  const ptyAdapter = input.ptyAdapter ?? (yield* PtyAdapter.PtyAdapter);
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, FreebuffSessionContext>();
  // The PTY monitor and public adapter methods can otherwise both pass the
  // session/active-turn checks before either has updated its state.
  const operationLock = yield* Semaphore.make(1);
  const adapterScope = yield* Scope.Scope;

  const eventStamp = (threadId: ThreadId) =>
    Effect.map(nowIso, (createdAt) => ({
      eventId: EventId.make(NodeCrypto.randomUUID()),
      provider: FREEBUFF_PROVIDER,
      providerInstanceId: input.instanceId,
      threadId,
      createdAt,
    }));

  const publish = (event: ProviderRuntimeEvent) =>
    PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

  const requireSession = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const session = sessions.get(threadId);
      if (!session) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: FREEBUFF_PROVIDER,
          threadId,
        });
      }
      if (session.stopped) {
        return yield* new ProviderAdapterSessionClosedError({
          provider: FREEBUFF_PROVIDER,
          threadId,
        });
      }
      return session;
    });

  const emitSessionState = (
    context: FreebuffSessionContext,
    state: ProviderSession["status"],
    reason?: string,
  ) =>
    Effect.gen(function* () {
      context.session = {
        ...context.session,
        status: state,
        updatedAt: yield* nowIso,
      };
      yield* publish({
        ...(yield* eventStamp(context.threadId)),
        type: "session.state.changed",
        payload: {
          state:
            state === "connecting"
              ? "starting"
              : state === "running"
                ? "running"
                : state === "closed"
                  ? "stopped"
                  : state === "error"
                    ? "error"
                    : "ready",
          ...(reason ? { reason } : {}),
        },
      });
    });

  const finishTurn = (
    context: FreebuffSessionContext,
    state: "completed" | "failed" | "cancelled",
    detail?: string,
  ) =>
    Effect.gen(function* () {
      const active = yield* Ref.modify(
        context.activeTurn,
        (current) => [current, undefined] as const,
      );
      if (!active) return;
      const output = extractVisibleAssistantText({
        baseline: active.baseline,
        current: active.latestScreen,
        prompt: active.prompt,
      });
      const record = context.turns.find((turn) => turn.id === active.id);
      if (record && output !== undefined) record.output = output;
      if (output) {
        yield* publish({
          ...(yield* eventStamp(context.threadId)),
          type: "content.delta",
          turnId: active.id,
          itemId: active.itemId,
          payload: { streamKind: "assistant_text", delta: output, contentIndex: 0 },
        });
      }
      yield* publish({
        ...(yield* eventStamp(context.threadId)),
        type: "item.completed",
        turnId: active.id,
        itemId: active.itemId,
        payload: {
          itemType: "assistant_message",
          status: state === "completed" ? "completed" : "failed",
        },
      });
      if (state === "cancelled") {
        yield* publish({
          ...(yield* eventStamp(context.threadId)),
          type: "turn.aborted",
          turnId: active.id,
          payload: { reason: detail ?? "The Freebuff turn was interrupted." },
        });
      } else {
        yield* publish({
          ...(yield* eventStamp(context.threadId)),
          type: "turn.completed",
          turnId: active.id,
          payload: {
            state: state === "failed" ? "failed" : "completed",
            stopReason: state === "failed" ? (detail ?? "unknown") : null,
            ...(state === "failed" && detail ? { errorMessage: detail } : {}),
          },
        });
      }
      const {
        activeTurnId: _activeTurnId,
        lastError: _lastError,
        ...sessionWithoutTurn
      } = context.session;
      context.session = {
        ...sessionWithoutTurn,
        status: context.stopped ? "closed" : state === "failed" ? "error" : "ready",
        ...(state === "failed" && !context.stopped
          ? { lastError: detail ?? "Freebuff turn failed." }
          : {}),
        updatedAt: yield* nowIso,
      };
      yield* publish({
        ...(yield* eventStamp(context.threadId)),
        type: "session.state.changed",
        payload: {
          state: context.stopped ? "stopped" : state === "failed" ? "error" : "ready",
          ...(detail ? { reason: detail } : {}),
        },
      });
    });

  const stopSessionInternal = (context: FreebuffSessionContext, reason: string) =>
    Effect.gen(function* () {
      if (context.stopped) return;
      context.stopped = true;
      sessions.delete(context.threadId);
      if (context.monitorFiber) {
        yield* Fiber.interrupt(context.monitorFiber).pipe(Effect.ignore);
      }
      yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
      yield* finishTurn(context, "cancelled", reason).pipe(Effect.ignore);
      yield* tryKillProcess(context.process).pipe(Effect.ignore);
      context.disposeTransport();
      const { activeTurnId: _activeTurnId, ...sessionWithoutTurn } = context.session;
      context.session = {
        ...sessionWithoutTurn,
        status: "closed",
        updatedAt: yield* nowIso,
      };
      yield* publish({
        ...(yield* eventStamp(context.threadId)),
        type: "session.exited",
        payload: { reason, recoverable: true, exitKind: "graceful" },
      });
    });

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (startInput) =>
    operationLock.withPermits(1)(
      Effect.gen(function* () {
        if (sessions.has(startInput.threadId)) {
          return yield* new ProviderAdapterRequestError({
            provider: FREEBUFF_PROVIDER,
            method: "session/start",
            detail: `A Freebuff session is already active for thread '${startInput.threadId}'.`,
          });
        }
        if (startInput.resumeCursor !== undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: FREEBUFF_PROVIDER,
            operation: "startSession",
            issue: "Freebuff's terminal bridge does not support provider-side conversation resume.",
          });
        }
        if (startInput.cwd !== undefined && startInput.cwd.trim() === "") {
          return yield* new ProviderAdapterValidationError({
            provider: FREEBUFF_PROVIDER,
            operation: "startSession",
            issue: "The Freebuff working directory cannot be empty.",
          });
        }
        if (startInput.runtimeMode !== "full-access") {
          return yield* new ProviderAdapterValidationError({
            provider: FREEBUFF_PROVIDER,
            operation: "startSession",
            issue: "Freebuff's terminal bridge currently supports only full-access sessions.",
          });
        }
        const cwd = startInput.cwd?.trim() || input.defaultCwd;
        const sessionScope = yield* Scope.make("sequential");
        let sessionScopeTransferred = false;
        yield* Scope.addFinalizer(
          adapterScope,
          Effect.suspend(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          ),
        );
        const launchArgs = [...tokenizeCliArgs(input.settings.launchArgs)];
        if (!launchArgs.includes("--trust-agents")) launchArgs.push("--trust-agents");
        launchArgs.push("--cwd", cwd);
        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: FREEBUFF_PROVIDER,
          providerInstanceId: input.instanceId,
          status: "connecting",
          runtimeMode: startInput.runtimeMode,
          cwd,
          ...(startInput.modelSelection?.model ? { model: startInput.modelSelection.model } : {}),
          threadId: startInput.threadId,
          createdAt,
          updatedAt: createdAt,
        };
        const processEvents = yield* Queue.unbounded<FreebuffProcessEvent>();
        const process = yield* ptyAdapter
          .spawn({
            shell: expandHomePath(input.settings.binaryPath || "freebuff"),
            args: launchArgs,
            cwd,
            cols: TERMINAL_COLUMNS,
            rows: TERMINAL_ROWS,
            env: {
              ...input.environment,
              FREEBUFF_CONFIG_DIR: input.configDir,
              TERM: "xterm-256color",
              COLORTERM: "truecolor",
            },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: FREEBUFF_PROVIDER,
                  threadId: startInput.threadId,
                  detail: "Failed to start the Freebuff terminal process.",
                  cause,
                }),
            ),
          );
        const terminal = new Terminal({ cols: TERMINAL_COLUMNS, rows: TERMINAL_ROWS });
        const removeDataListener = process.onData((data) => terminal.write(data));
        const parsedListener = terminal.onWriteParsed(() => {
          Queue.offerUnsafe(processEvents, { type: "screen", value: terminalText(terminal) });
        });
        const removeExitListener = process.onExit(({ exitCode }) => {
          Queue.offerUnsafe(processEvents, { type: "exit", exitCode });
        });
        const activeTurn = yield* Ref.make<ActiveTerminalTurn | undefined>(undefined);
        const lastScreen = yield* Ref.make("");
        const context: FreebuffSessionContext = {
          threadId: startInput.threadId,
          process,
          processEvents,
          terminal,
          configDir: input.configDir,
          scope: sessionScope,
          session,
          turns: [],
          activeTurn,
          lastScreen,
          disposeTransport: () => {
            removeDataListener();
            parsedListener.dispose();
            removeExitListener();
            terminal.dispose();
          },
          stopped: false,
        };

        const monitor = Effect.gen(function* () {
          while (!context.stopped) {
            const current = yield* Ref.get(activeTurn);
            const next = yield* Effect.raceFirst(
              Queue.take(processEvents).pipe(
                Effect.map((event) => ({ type: "event" as const, event })),
              ),
              current
                ? Effect.sleep(TURN_SETTLE_MS).pipe(Effect.as({ type: "settle" as const }))
                : Effect.never,
            );
            if (next.type === "settle") {
              const active = yield* Ref.get(activeTurn);
              if (!active) continue;
              if (!active.submitted && !active.abortRequested) {
                yield* tryWriteProcess(
                  context.process,
                  encodePrompt(active.prompt, context.terminal.modes.bracketedPasteMode),
                ).pipe(
                  Effect.catch(() =>
                    finishTurn(context, "failed", "Failed to write the prompt to Freebuff."),
                  ),
                );
                active.submitted = true;
                continue;
              }
              if (
                !active.abortRequested &&
                extractVisibleAssistantText({
                  baseline: active.baseline,
                  current: active.latestScreen,
                  prompt: active.prompt,
                }).length === 0
              ) {
                // A quiet screen is not proof that Freebuff finished. Keep the
                // turn active until visible assistant output arrives instead
                // of reporting a false completion after a fixed delay.
                continue;
              }
              yield* finishTurn(
                context,
                active.abortRequested ? "cancelled" : "completed",
                active.abortRequested ? "The Freebuff turn was interrupted." : undefined,
              );
              continue;
            }
            if (next.event.type === "exit") {
              if (!context.stopped) {
                yield* finishTurn(context, "failed", "The Freebuff terminal exited unexpectedly.");
                context.stopped = true;
                sessions.delete(context.threadId);
                context.disposeTransport();
                context.session = { ...context.session, status: "error", updatedAt: yield* nowIso };
                yield* publish({
                  ...(yield* eventStamp(context.threadId)),
                  type: "session.exited",
                  payload: {
                    reason: "Freebuff terminal exited.",
                    recoverable: false,
                    exitKind: "error",
                  },
                });
              }
              return;
            }

            const screen = next.event.value;
            yield* Ref.set(lastScreen, screen);
            if (requiresAuthentication(screen)) {
              yield* finishTurn(
                context,
                "failed",
                "Freebuff is not authenticated. Sign in from a Freebuff terminal using this instance's configuration directory, then retry.",
              );
              yield* publish({
                ...(yield* eventStamp(context.threadId)),
                type: "runtime.warning",
                payload: {
                  message:
                    "Freebuff requires authentication. Open a Freebuff terminal for this provider instance to sign in.",
                },
              });
              continue;
            }
            const active = yield* Ref.get(activeTurn);
            if (!active) continue;
            active.latestScreen = screen;
            if (!active.submitted && !isBusyScreen(screen)) {
              active.submitted = true;
              yield* tryWriteProcess(
                context.process,
                encodePrompt(active.prompt, context.terminal.modes.bracketedPasteMode),
              ).pipe(
                Effect.catch((cause) =>
                  Effect.gen(function* () {
                    yield* finishTurn(context, "failed", "Failed to write the prompt to Freebuff.");
                    yield* Effect.logWarning("Freebuff prompt write failed.", { cause });
                  }),
                ),
              );
            }
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Freebuff terminal monitor stopped.", { cause }),
          ),
        );

        context.monitorFiber = yield* Effect.forkIn(sessionScope)(monitor);
        sessionScopeTransferred = true;
        sessions.set(startInput.threadId, context);
        yield* publish({
          ...(yield* eventStamp(startInput.threadId)),
          type: "session.started",
          payload: {
            message: "Connected to the Freebuff terminal bridge.",
            resume: { schemaVersion: 1, configDir: input.configDir },
          },
        });
        yield* publish({
          ...(yield* eventStamp(startInput.threadId)),
          type: "thread.started",
          payload: {},
        });
        yield* publish({
          ...(yield* eventStamp(startInput.threadId)),
          type: "session.configured",
          payload: {
            config: {
              terminalBridge: true,
              configDir: input.configDir,
              cwd,
              runtimeMode: startInput.runtimeMode,
            },
          },
        });
        yield* emitSessionState(context, "ready");
        return context.session;
      }),
    );

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (turnInput) =>
    operationLock.withPermits(1)(
      Effect.gen(function* () {
        const context = yield* requireSession(turnInput.threadId);
        if (turnInput.attachments && turnInput.attachments.length > 0) {
          return yield* new ProviderAdapterValidationError({
            provider: FREEBUFF_PROVIDER,
            operation: "sendTurn",
            issue: "Freebuff's terminal bridge does not support T3 attachment transport yet.",
          });
        }
        const text = turnInput.input?.trim();
        if (!text) {
          return yield* new ProviderAdapterValidationError({
            provider: FREEBUFF_PROVIDER,
            operation: "sendTurn",
            issue: "Freebuff requires a non-empty prompt.",
          });
        }
        if (yield* Ref.get(context.activeTurn)) {
          return yield* new ProviderAdapterRequestError({
            provider: FREEBUFF_PROVIDER,
            method: "turn/send",
            detail: "Freebuff's terminal bridge supports one active turn per thread.",
          });
        }
        const turnId = TurnId.make(NodeCrypto.randomUUID());
        const itemId = RuntimeItemId.make(NodeCrypto.randomUUID());
        const baseline = yield* Ref.get(context.lastScreen);
        const prompt = `${text}\n\n${buildRuntimeInstructions({
          harness: "Freebuff",
          ...(turnInput.modelSelection ? { model: turnInput.modelSelection.model } : {}),
        })}`;
        const active: ActiveTerminalTurn = {
          id: turnId,
          itemId,
          prompt,
          baseline,
          latestScreen: baseline,
          submitted: false,
          abortRequested: false,
        };
        yield* Ref.set(context.activeTurn, active);
        // Wake the monitor even when Freebuff has not emitted a screen update
        // since the previous turn. Without this sentinel the settle timeout
        // would not be armed for a quiet first prompt.
        Queue.offerUnsafe(context.processEvents, { type: "screen", value: baseline });
        context.turns.push({ id: turnId, prompt: text });
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };
        yield* publish({
          ...(yield* eventStamp(turnInput.threadId)),
          type: "turn.started",
          turnId,
          payload: turnInput.modelSelection?.model ? { model: turnInput.modelSelection.model } : {},
        });
        yield* publish({
          ...(yield* eventStamp(turnInput.threadId)),
          type: "item.started",
          turnId,
          itemId,
          payload: { itemType: "assistant_message", status: "inProgress" },
        });
        yield* publish({
          ...(yield* eventStamp(turnInput.threadId)),
          type: "session.state.changed",
          payload: { state: "running" },
        });
        if (baseline && !isBusyScreen(baseline)) {
          active.submitted = true;
          yield* tryWriteProcess(
            context.process,
            encodePrompt(active.prompt, context.terminal.modes.bracketedPasteMode),
          ).pipe(
            Effect.catch(() =>
              finishTurn(context, "failed", "Failed to write the prompt to Freebuff."),
            ),
          );
        }
        return {
          threadId: turnInput.threadId,
          turnId,
          resumeCursor: { schemaVersion: 1, configDir: input.configDir },
        };
      }),
    );

  const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (threadId) =>
    operationLock.withPermits(1)(
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const active = yield* Ref.get(context.activeTurn);
        if (!active) return;
        active.abortRequested = true;
        Queue.offerUnsafe(context.processEvents, {
          type: "screen",
          value: yield* Ref.get(context.lastScreen),
        });
        // A race with terminal exit is handled by the monitor.
        yield* tryWriteProcess(context.process, "\u001b").pipe(Effect.ignore);
      }),
    );

  const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
    _threadId,
    _requestId,
    _decision,
  ) => unsupportedInteraction("request/respond");

  const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
    _threadId,
    _requestId,
    _answers,
  ) => unsupportedInteraction("user-input/respond");

  const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      return {
        threadId,
        turns: context.turns.map((turn) => ({
          id: turn.id,
          items: [
            { type: "user_message", text: turn.prompt },
            ...(turn.output === undefined
              ? []
              : [{ type: "assistant_message", text: turn.output }]),
          ],
        })),
      };
    });

  const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
    threadId,
    numTurns,
  ) =>
    Effect.gen(function* () {
      yield* requireSession(threadId);
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* new ProviderAdapterValidationError({
          provider: FREEBUFF_PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        });
      }
      return yield* new ProviderAdapterRequestError({
        provider: FREEBUFF_PROVIDER,
        method: "thread/rollback",
        detail: "Freebuff's terminal bridge does not expose provider-side rollback.",
      });
    });

  const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
    operationLock.withPermits(1)(
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        yield* stopSessionInternal(context, "Session stopped.");
      }),
    );

  const listSessions = () =>
    Effect.sync(() => Array.from(sessions.values(), (context) => ({ ...context.session })));
  const hasSession = (threadId: ThreadId) => Effect.sync(() => sessions.has(threadId));
  const stopAll = () =>
    Effect.forEach(Array.from(sessions.values()), (context) =>
      stopSessionInternal(context, "Provider stopped."),
    );

  yield* Effect.addFinalizer(() =>
    stopAll().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to stop Freebuff sessions.", { cause }),
      ),
      Effect.andThen(PubSub.shutdown(runtimeEventPubSub)),
    ),
  );

  return {
    provider: FREEBUFF_PROVIDER,
    capabilities: { sessionModelSwitch: "unsupported", supportsConversationRollback: false },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});
