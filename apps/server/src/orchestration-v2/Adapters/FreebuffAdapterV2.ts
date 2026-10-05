import XtermHeadless from "@xterm/headless";
import {
  FREEBUFF_DEFAULT_MODEL,
  type FreebuffSettings,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderSession,
  type ProviderInstanceId,
  type ProviderTurnId,
  type ThreadId,
} from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { FREEBUFF_PROVIDER } from "../../provider/Layers/FreebuffProvider.ts";
import { buildRuntimeInstructions } from "../../provider/RuntimeInstructions.ts";
import * as PtyAdapter from "../../terminal/PtyAdapter.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ProviderAdapter from "../ProviderAdapter.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import {
  classifyFreebuffScreen,
  extractVisibleAssistantText,
  hasFreebuffChatGate,
  isBusyScreen,
  mergeVisibleAssistantText,
  screenTail,
  TERMINAL_COLUMNS,
  TERMINAL_ROWS,
  TERMINAL_SCROLLBACK,
  terminalText,
  type FreebuffScreenState,
  type XtermTerminal,
} from "./FreebuffScreen.ts";

const { Terminal } = XtermHeadless as unknown as {
  readonly Terminal: typeof import("@xterm/headless").Terminal;
};
const isPtySpawnError = Schema.is(PtyAdapter.PtySpawnError);

const TURN_SETTLE_MS = 4_000;
const INTERRUPT_SETTLE_MS = 750;
const ADMISSION_ACTION_SETTLE_MS = 750;
const IDLE_SCREEN_POLL_MS = 100;
const ADMISSION_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 60 * 60_000;
const PROCESS_STOP_GRACE_MS = 2_000;
const MAX_RETAINED_TURNS = 100;
const ESC = "\u001b";

/**
 * What the terminal bridge can actually do.
 *
 * One terminal is one conversation, so a session hosts a single provider thread
 * and cannot switch models: Freebuff picks its model inside the TUI and T3 keeps
 * one opaque alias. There is no transcript to truncate, so neither rollback nor a
 * conversation snapshot is available, and a screen carries no tool or subagent
 * structure — only the assistant's rendered text.
 */
export const FreebuffProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    // The CLI has no queue of its own: one prompt is written at a time and the
    // next turn waits for the screen to settle.
    supportsQueuedMessages: false,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: false,
    emitsToolStarted: false,
    emitsToolCompleted: false,
    emitsToolOutput: false,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: false,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: true,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    // The screen names neither threads nor turns; ids are T3's own.
    nativeThreadIds: "none",
    nativeTurnIds: "none",
    nativeItemIds: "none",
    nativeRequestIds: "none",
  },
  // The bridge launches the CLI in full-access and T3 cannot narrow it, so the
  // access mode is fixed by the launch rather than enforced per request.
  runtimePolicy: {
    enforcement: "client-boundary",
  },
} satisfies OrchestrationV2ProviderCapabilities;

type FreebuffProcessEvent =
  | { readonly type: "screen"; readonly value: string }
  | { readonly type: "exit"; readonly event: PtyAdapter.PtyExitEvent };

interface FreebuffProcessState {
  current: FreebuffProcessEvent | undefined;
  exited: boolean;
}

interface ActiveTerminalTurn {
  readonly providerTurnId: ProviderTurnId;
  readonly runOrdinal: number;
  readonly itemOrdinal: number;
  readonly userPrompt: string;
  readonly prompt: string;
  readonly baseline: string;
  output: string;
  readonly admission: Deferred.Deferred<void>;
  readonly admissionDeadlineAt: number;
  readonly deadlineAt: number;
  latestScreen: string;
  admissionScreen: string | undefined;
  admissionWrites: number;
  lastAdmissionWriteAt: number | undefined;
  submitted: boolean;
  announced: boolean;
  abortRequested: boolean;
}

interface FreebuffTurnRecord {
  readonly providerTurnId: ProviderTurnId;
  readonly prompt: string;
  output?: string;
}

export interface FreebuffAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: FreebuffSettings;
  readonly configDir: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly serverConfig: ServerConfig["Service"];
  readonly ptyAdapter?: PtyAdapter.PtyAdapterService;
}

/** A bracketed-paste prompt, or a single line when the CLI has paste mode off. */
const encodePrompt = (prompt: string, bracketedPaste: boolean): string =>
  bracketedPaste ? `${ESC}[200~${prompt}${ESC}[201~\r` : `${prompt.replaceAll(/\r?\n/gu, " ")}\r`;

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

const tryKillProcess = (process: PtyAdapter.PtyProcess, signal: string) =>
  Effect.try({
    try: () => {
      process.kill(signal);
    },
    catch: (cause) => new FreebuffTerminalProcessError("kill", cause),
  });

/**
 * Collapse the stream of PTY writes into one pending event. A raw chunk is the
 * freshest bytes, and a parsed screen supersedes it, so only the last of each
 * kind survives to be classified.
 */
const enqueueProcessEvent = (
  state: FreebuffProcessState,
  wakeQueue: Queue.Queue<true>,
  event: FreebuffProcessEvent,
): void => {
  if (state.exited && event.type === "screen") return;
  if (state.current?.type === "exit") return;
  // A blank screen after a painted one is a cursor move, not a clear: taking it
  // would erase the answer the next turn diffs against.
  if (
    state.current?.type === "screen" &&
    event.type === "screen" &&
    state.current.value.trim().length > 0 &&
    event.value.trim().length === 0
  ) {
    return;
  }
  state.current = event;
  Queue.offerUnsafe(wakeQueue, true);
  Queue.flushUnsafe(wakeQueue);
};

/**
 * An overlay the user has to clear, as opposed to a word that merely appears in
 * a conversation. Once a prompt is on the chat screen, the same text is part of
 * the transcript rather than a gate.
 */
const blockedByScreen = (
  state: FreebuffScreenState,
  screen: string,
  submitted: boolean,
): string | null => {
  if (state.kind !== "authentication" && state.kind !== "blocked") return null;
  if (submitted && hasFreebuffChatGate(screen)) return null;
  return state.detail;
};

export function makeFreebuffAdapterV2(
  options: FreebuffAdapterV2Options,
): ProviderAdapter.ProviderAdapterV2Shape {
  const openSession = (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
    Effect.gen(function* () {
      const ptyAdapter = options.ptyAdapter ?? (yield* PtyAdapter.PtyAdapter);
      const scope = yield* Scope.Scope;
      const operationLock = yield* Semaphore.make(1);
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(events, event).pipe(Effect.asVoid);
      const nativeThreadId = input.threadId;
      let providerThreadId: OrchestrationV2ProviderThread["id"] | null = null;

      const cwd = input.runtimePolicy.cwd ?? options.serverConfig.cwd;
      const sessionStartedAt = yield* DateTime.now;
      let sessionEntity: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: FREEBUFF_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "starting",
        cwd,
        model: input.modelSelection.model || FREEBUFF_DEFAULT_MODEL,
        capabilities: FreebuffProviderCapabilitiesV2,
        createdAt: sessionStartedAt,
        updatedAt: sessionStartedAt,
        lastError: null,
      };
      const publishSession = (status: OrchestrationV2ProviderSession["status"], detail?: string) =>
        Effect.gen(function* () {
          const updatedAt = yield* DateTime.now;
          sessionEntity = {
            ...sessionEntity,
            status,
            ...(detail === undefined ? {} : { lastError: detail }),
            updatedAt,
          };
          yield* emit({
            type: "provider_session.updated",
            driver: FREEBUFF_PROVIDER,
            providerSession: sessionEntity,
          });
        });
      const boundThreadId = () => {
        if (providerThreadId === null) {
          throw new Error("Freebuff turn requested before the provider thread was registered.");
        }
        return providerThreadId;
      };

      const launchArgs = tokenizeCliArgs(options.settings.launchArgs).filter(
        (argument) => argument !== "--trust-agents",
      );
      if (options.settings.trustRepositoryAgents) launchArgs.push("--trust-agents");
      launchArgs.push("--cwd", cwd);
      const processEnvironment: NodeJS.ProcessEnv = {
        ...options.environment,
        FREEBUFF_CONFIG_DIR: options.configDir,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      };
      const resolvedCommand = yield* resolveSpawnCommand(
        expandHomePath(options.settings.binaryPath || "freebuff"),
        launchArgs,
        { env: processEnvironment },
      );
      const ptyCommand = resolvedCommand.shell
        ? {
            shell: processEnvironment.ComSpec ?? "cmd.exe",
            args: ["/d", "/s", "/c", [resolvedCommand.command, ...resolvedCommand.args].join(" ")],
          }
        : { shell: resolvedCommand.command, args: [...resolvedCommand.args] };
      const processState: FreebuffProcessState = { current: undefined, exited: false };
      const wakeQueue = yield* Queue.bounded<true>(1);
      const exit = yield* Deferred.make<PtyAdapter.PtyExitEvent>();
      const stopped = yield* Deferred.make<void>();
      const activeTurnRef = yield* Ref.make<ActiveTerminalTurn | undefined>(undefined);
      const lastScreenRef = yield* Ref.make("");
      const process = yield* ptyAdapter
        .spawn({
          ...ptyCommand,
          cwd,
          cols: TERMINAL_COLUMNS,
          rows: TERMINAL_ROWS,
          env: processEnvironment,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: FREEBUFF_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause: new Error(
                  isPtySpawnError(cause) && cause.adapter === "unavailable"
                    ? "Freebuff requires the server's local PTY adapter, but it is unavailable."
                    : `Failed to start the Freebuff terminal process: ${cause}`,
                ),
              }),
          ),
        );
      const terminal = new Terminal({
        allowProposedApi: true,
        cols: TERMINAL_COLUMNS,
        rows: TERMINAL_ROWS,
        scrollback: TERMINAL_SCROLLBACK,
      });
      let renderedScreen = "";
      const removeDataListener = process.onData((data) => {
        terminal.write(data);
        enqueueProcessEvent(processState, wakeQueue, { type: "screen", value: data });
      });
      const parsedListener = terminal.onWriteParsed(() => {
        renderedScreen = terminalText(terminal);
        enqueueProcessEvent(processState, wakeQueue, { type: "screen", value: renderedScreen });
      });
      const removeExitListener = process.onExit((event) => {
        processState.exited = true;
        Deferred.doneUnsafe(exit, Effect.succeed(event));
        enqueueProcessEvent(processState, wakeQueue, { type: "exit", event });
      });
      let transportDisposed = false;
      const disposeTransport = () => {
        if (transportDisposed) return;
        transportDisposed = true;
        removeDataListener();
        parsedListener.dispose();
        removeExitListener();
        terminal.dispose();
      };
      const turns: Array<FreebuffTurnRecord> = [];
      let stoppedFlag = false;

      const assistantItemId = (providerTurnId: ProviderTurnId) =>
        options.idAllocator.derive.turnItemFromProviderItem({
          driver: FREEBUFF_PROVIDER,
          nativeItemId: `${providerTurnId}:assistant`,
        });
      const assistantMessageId = (providerTurnId: ProviderTurnId) =>
        options.idAllocator.derive.messageFromProviderItem({
          driver: FREEBUFF_PROVIDER,
          nativeItemId: `${providerTurnId}:assistant`,
        });

      const emitAssistantItem = (
        turn: ActiveTerminalTurn,
        status: "running" | "completed" | "cancelled",
      ) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          yield* emit({
            type: "turn_item.updated",
            driver: FREEBUFF_PROVIDER,
            turnItem: {
              id: assistantItemId(turn.providerTurnId),
              threadId: input.threadId,
              runId: null,
              nodeId: null,
              providerThreadId: boundThreadId(),
              providerTurnId: turn.providerTurnId,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: turn.itemOrdinal,
              status,
              title: null,
              startedAt: now,
              completedAt: status === "running" ? null : now,
              updatedAt: now,
              type: "assistant_message",
              messageId: assistantMessageId(turn.providerTurnId),
              text: turn.output,
              streaming: status === "running",
            },
          });
        });

      const failTurn = (turn: ActiveTerminalTurn, detail: string) =>
        Effect.gen(function* () {
          const failure = makeProviderFailure({ message: detail, class: "provider_error" });
          const now = yield* DateTime.now;
          const failureItemOrdinal = turn.itemOrdinal + 1;
          yield* emit({
            type: "turn_item.updated",
            driver: FREEBUFF_PROVIDER,
            turnItem: {
              id: options.idAllocator.derive.turnItemFromProviderItem({
                driver: FREEBUFF_PROVIDER,
                nativeItemId: `${turn.providerTurnId}:failure`,
              }),
              threadId: input.threadId,
              runId: null,
              nodeId: null,
              providerThreadId: boundThreadId(),
              providerTurnId: turn.providerTurnId,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: failureItemOrdinal,
              status: "failed",
              title: null,
              startedAt: null,
              completedAt: now,
              updatedAt: now,
              type: "error",
              failure,
            },
          });
          yield* emit({
            type: "turn.terminal",
            driver: FREEBUFF_PROVIDER,
            providerThreadId: boundThreadId(),
            providerTurnId: turn.providerTurnId,
            runOrdinal: turn.runOrdinal,
            failureItemOrdinal,
            status: "failed",
            failure,
            threadDisposition: "reusable",
          });
        });

      const finishTurn = (turn: ActiveTerminalTurn, status: "completed" | "interrupted") =>
        Effect.gen(function* () {
          turn.output = mergeVisibleAssistantText(
            turn.output,
            extractVisibleAssistantText({
              baseline: turn.baseline,
              current: turn.latestScreen,
              prompt: turn.userPrompt,
            }),
          );
          const record = turns.find((entry) => entry.providerTurnId === turn.providerTurnId);
          if (record && turn.output) record.output = turn.output;
          yield* emitAssistantItem(turn, status === "completed" ? "completed" : "cancelled");
          yield* emit({
            type: "turn.terminal",
            driver: FREEBUFF_PROVIDER,
            providerThreadId: boundThreadId(),
            providerTurnId: turn.providerTurnId,
            runOrdinal: turn.runOrdinal,
            status,
            failure: null,
            threadDisposition: "reusable",
          });
        });

      /**
       * A turn that was never written to the terminal produced no run the
       * orchestrator can reconcile, so it is dropped rather than terminalized:
       * an empty completed turn would read as the agent answering nothing.
       */
      const dropUnsubmittedTurn = (turn: ActiveTerminalTurn, detail: string) =>
        Effect.logDebug("Freebuff turn never reached the chat screen.", {
          detail,
          providerTurnId: turn.providerTurnId,
        }).pipe(Effect.asVoid);

      const submitActiveTurn = (turn: ActiveTerminalTurn) =>
        Effect.gen(function* () {
          yield* tryWriteProcess(
            process,
            encodePrompt(turn.prompt, terminal.modes.bracketedPasteMode),
          );
          turn.submitted = true;
          turn.announced = true;
          turns.push({ providerTurnId: turn.providerTurnId, prompt: turn.userPrompt });
          if (turns.length > MAX_RETAINED_TURNS) turns.shift();
          yield* emitAssistantItem(turn, "running");
          yield* Deferred.succeed(turn.admission, undefined);
        });

      const admitActiveTurn = (
        turn: ActiveTerminalTurn,
        screen: string,
        now: number,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          // The landing screen needs one Enter; a second write means the CLI is
          // not advancing and another keystroke would type into the prompt.
          if (turn.admissionWrites >= 2 || turn.admissionScreen === screen) return;
          if (
            turn.lastAdmissionWriteAt !== undefined &&
            now - turn.lastAdmissionWriteAt < ADMISSION_ACTION_SETTLE_MS
          ) {
            return;
          }
          yield* tryWriteProcess(process, "\r").pipe(Effect.ignore);
          turn.admissionScreen = screen;
          turn.admissionWrites += 1;
          turn.lastAdmissionWriteAt = now;
        });

      const terminateProcess = Effect.gen(function* () {
        if (processState.exited) return;
        yield* tryKillProcess(process, "SIGTERM").pipe(Effect.ignore);
        const graceful = yield* Deferred.await(exit).pipe(
          Effect.timeoutOption(PROCESS_STOP_GRACE_MS),
        );
        if (Option.isSome(graceful)) return;
        yield* tryKillProcess(process, "SIGKILL").pipe(Effect.ignore);
        yield* Deferred.await(exit).pipe(Effect.timeoutOption(PROCESS_STOP_GRACE_MS));
      });

      const stopTransport = Effect.gen(function* () {
        if (stoppedFlag) return;
        stoppedFlag = true;
        yield* operationLock.withPermits(1)(
          Effect.gen(function* () {
            const active = yield* Ref.get(activeTurnRef);
            if (active === undefined) return;
            yield* Ref.set(activeTurnRef, undefined);
            yield* active.submitted
              ? finishTurn(active, "interrupted")
              : dropUnsubmittedTurn(active, "Freebuff session stopped.");
          }),
        );
        yield* terminateProcess;
        disposeTransport();
        Deferred.doneUnsafe(stopped, Effect.void);
        yield* publishSession("stopped");
      });
      // However the session ends — scope close, an idle release, a server
      // shutdown — the terminal must not outlive it.
      yield* Scope.addFinalizer(
        scope,
        Effect.uninterruptibleMask((restore) =>
          Effect.suspend(() => stopTransport.pipe(restore)).pipe(Effect.ignore),
        ),
      );

      const handleUnexpectedExit = (event: PtyAdapter.PtyExitEvent) =>
        operationLock.withPermits(1)(
          Effect.gen(function* () {
            if (stoppedFlag) return;
            stoppedFlag = true;
            const detail =
              event.signal === null
                ? `Freebuff terminal exited with code ${event.exitCode}.`
                : `Freebuff terminal exited after signal ${event.signal}.`;
            const active = yield* Ref.get(activeTurnRef);
            if (active !== undefined) {
              yield* Ref.set(activeTurnRef, undefined);
              if (active.submitted) yield* failTurn(active, detail);
            }
            disposeTransport();
            Deferred.doneUnsafe(stopped, Effect.void);
            yield* publishSession("error", detail);
          }),
        );

      const streamAssistantText = (turn: ActiveTerminalTurn) =>
        Effect.gen(function* () {
          turn.output = mergeVisibleAssistantText(
            turn.output,
            extractVisibleAssistantText({
              baseline: turn.baseline,
              current: turn.latestScreen,
              prompt: turn.userPrompt,
            }),
          );
          if (turn.output.length === 0) return;
          yield* emitAssistantItem(turn, "running");
        });

      const processScreenEvent = (rawScreen: string) =>
        operationLock.withPermits(1)(
          Effect.gen(function* () {
            if (stoppedFlag) return;
            // Classification reads the event, which between a PTY write and the
            // terminal's parse callback is the raw chunk and so the freshest
            // view of the screen. Text is only ever taken from the rendered
            // screen: a raw chunk can match a gate pattern inside a partially
            // painted line, and treating that as the screen would publish the
            // terminal's own control sequences as the assistant's answer.
            const eventState = classifyFreebuffScreen(screenTail(rawScreen));
            const currentScreen = renderedScreen;
            const now = yield* Clock.currentTimeMillis;
            const turn = yield* Ref.get(activeTurnRef);
            if (currentScreen.length > 0) yield* Ref.set(lastScreenRef, currentScreen);
            if (turn) turn.latestScreen = currentScreen;
            const screenState =
              eventState.kind === "unknown" && currentScreen.length > 0
                ? classifyFreebuffScreen(screenTail(currentScreen))
                : eventState;
            const blocked = blockedByScreen(screenState, currentScreen, turn?.submitted ?? false);
            if (blocked !== null) {
              if (turn === undefined) return yield* publishSession("error", blocked);
              yield* Ref.set(activeTurnRef, undefined);
              return yield* turn.submitted
                ? failTurn(turn, blocked)
                : dropUnsubmittedTurn(turn, blocked);
            }
            if (turn === undefined || turn.abortRequested || turn.submitted) {
              if (turn?.submitted) yield* streamAssistantText(turn);
              return;
            }
            if (now >= turn.deadlineAt) {
              yield* Ref.set(activeTurnRef, undefined);
              return yield* dropUnsubmittedTurn(turn, "The Freebuff turn timed out.");
            }
            if (now >= turn.admissionDeadlineAt) {
              yield* Ref.set(activeTurnRef, undefined);
              return yield* dropUnsubmittedTurn(turn, "Freebuff did not reach its chat screen.");
            }
            if (screenState.kind === "landing") {
              return yield* admitActiveTurn(turn, currentScreen, now);
            }
            if (screenState.kind === "chat") {
              return yield* submitActiveTurn(turn);
            }
          }),
        );

      const processSettle = () =>
        operationLock.withPermits(1)(
          Effect.gen(function* () {
            if (stoppedFlag) return;
            const turn = yield* Ref.get(activeTurnRef);
            if (turn === undefined) return;
            if (renderedScreen.length > 0) turn.latestScreen = renderedScreen;
            const now = yield* Clock.currentTimeMillis;
            const screenState = classifyFreebuffScreen(screenTail(turn.latestScreen));
            const blocked = blockedByScreen(screenState, turn.latestScreen, turn.submitted);
            if (blocked !== null) {
              yield* Ref.set(activeTurnRef, undefined);
              return yield* turn.submitted
                ? failTurn(turn, blocked)
                : dropUnsubmittedTurn(turn, blocked);
            }
            if (turn.abortRequested) {
              // The CLI paints "esc to interrupt" until it actually stops.
              if (isBusyScreen(turn.latestScreen)) return;
              yield* Ref.set(activeTurnRef, undefined);
              return yield* turn.submitted
                ? finishTurn(turn, "interrupted")
                : dropUnsubmittedTurn(turn, "The Freebuff turn was interrupted.");
            }
            if (!turn.submitted) {
              if (now >= turn.deadlineAt) {
                yield* Ref.set(activeTurnRef, undefined);
                return yield* dropUnsubmittedTurn(turn, "The Freebuff turn timed out.");
              }
              if (now >= turn.admissionDeadlineAt) {
                yield* Ref.set(activeTurnRef, undefined);
                return yield* dropUnsubmittedTurn(turn, "Freebuff did not reach its chat screen.");
              }
              if (screenState.kind === "landing") {
                return yield* admitActiveTurn(turn, turn.latestScreen, now);
              }
              if (screenState.kind === "chat") {
                return yield* submitActiveTurn(turn);
              }
              return;
            }
            if (now >= turn.deadlineAt) {
              yield* Ref.set(activeTurnRef, undefined);
              return yield* failTurn(turn, "The Freebuff turn exceeded its maximum duration.");
            }
            // The CLI is done when it stops painting progress; anything still on
            // screen then is the answer.
            if (isBusyScreen(turn.latestScreen)) {
              yield* streamAssistantText(turn);
              return;
            }
            turn.output = mergeVisibleAssistantText(
              turn.output,
              extractVisibleAssistantText({
                baseline: turn.baseline,
                current: turn.latestScreen,
                prompt: turn.userPrompt,
              }),
            );
            if (turn.output.length > 0) {
              yield* Ref.set(activeTurnRef, undefined);
              return yield* finishTurn(turn, "completed");
            }
          }),
        );

      const monitor = Effect.gen(function* () {
        while (!stoppedFlag) {
          const active = yield* Ref.get(activeTurnRef);
          const nextEvent = Queue.take(wakeQueue).pipe(Effect.as({ type: "event" as const }));
          const next = yield* active
            ? nextEvent.pipe(
                Effect.timeoutOrElse({
                  duration: active.abortRequested ? INTERRUPT_SETTLE_MS : TURN_SETTLE_MS,
                  orElse: () => Effect.succeed({ type: "settle" as const }),
                }),
              )
            : nextEvent.pipe(
                Effect.timeoutOrElse({
                  duration: IDLE_SCREEN_POLL_MS,
                  orElse: () => Effect.succeed({ type: "poll" as const }),
                }),
              );
          if (next.type === "settle") {
            yield* processSettle();
            continue;
          }
          const event = processState.current;
          processState.current = undefined;
          if (event === undefined) continue;
          if (event.type === "exit") {
            yield* handleUnexpectedExit(event.event);
            return;
          }
          yield* processScreenEvent(event.value);
        }
      });
      const monitorFiber = yield* Effect.forkIn(scope)(
        monitor.pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("The Freebuff terminal monitor stopped.", { cause });
              // The monitor is the only reader of the screen, so losing it
              // strands an in-flight turn with no way to settle.
              yield* handleUnexpectedExit({
                exitCode: 0,
                signal: null,
                // The CLI is still running; the turn cannot be completed.
              } as PtyAdapter.PtyExitEvent);
            }),
          ),
        ),
      );

      if (processState.exited) {
        yield* stopTransport;
        return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
          driver: FREEBUFF_PROVIDER,
          providerSessionId: input.providerSessionId,
          cause: new Error("The Freebuff terminal exited while the session was starting."),
        });
      }
      yield* publishSession("ready");

      const startTurnError = (
        turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
        detail: string,
      ) =>
        new ProviderAdapter.ProviderAdapterTurnStartError({
          driver: FREEBUFF_PROVIDER,
          threadId: turnInput.threadId,
          providerThreadId: turnInput.providerThread.id,
          runId: turnInput.runId,
          cause: new Error(detail),
        });

      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: FREEBUFF_PROVIDER,
        providerSessionId: input.providerSessionId,
        get providerSession() {
          return sessionEntity;
        },
        events: Stream.fromQueue(events),
        ensureThread: (threadInput) =>
          Effect.gen(function* () {
            const updatedAt = yield* DateTime.now;
            const existing = threadInput.existingProviderThread;
            const providerThread: OrchestrationV2ProviderThread =
              existing ??
              ({
                id: options.idAllocator.derive.providerThread({
                  driver: FREEBUFF_PROVIDER,
                  providerInstanceId: options.instanceId,
                  nativeThreadId: nativeThreadId,
                }),
                driver: FREEBUFF_PROVIDER,
                providerInstanceId: options.instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: null,
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt: updatedAt,
                updatedAt,
              } satisfies OrchestrationV2ProviderThread);
            providerThreadId = providerThread.id;
            const ready: OrchestrationV2ProviderThread = {
              ...providerThread,
              status: "idle",
              updatedAt,
            };
            yield* emit({
              type: "provider_thread.updated",
              driver: FREEBUFF_PROVIDER,
              providerThread: ready,
            });
            return ready;
          }),
        resumeThread: (threadInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterResumeThreadError({
              driver: FREEBUFF_PROVIDER,
              providerSessionId: input.providerSessionId,
              providerThreadId: threadInput.providerThread.id,
              cause: new Error("Freebuff's terminal bridge cannot resume a provider conversation."),
            }),
          ),
        startTurn: (turnInput) =>
          Effect.gen(function* () {
            const text = turnInput.message.text.trim();
            if (stoppedFlag) {
              return yield* startTurnError(turnInput, "The Freebuff session is no longer running.");
            }
            if (turnInput.message.attachments.length > 0) {
              return yield* startTurnError(
                turnInput,
                "Freebuff's terminal bridge cannot take attachments.",
              );
            }
            if (text.length === 0) {
              return yield* startTurnError(turnInput, "Freebuff requires a non-empty prompt.");
            }
            // The bridge has no native turn id, so T3 mints one and uses it for
            // the terminal event the orchestrator reconciles against.
            const currentTurnId = options.idAllocator.derive.providerTurn({
              driver: FREEBUFF_PROVIDER,
              nativeTurnId: `${turnInput.providerThread.id}:${turnInput.providerTurnOrdinal}`,
            });
            const turn = yield* operationLock.withPermits(1)(
              Effect.gen(function* () {
                if ((yield* Ref.get(activeTurnRef)) !== undefined) {
                  return yield* startTurnError(
                    turnInput,
                    "Freebuff's terminal bridge supports one active turn per session.",
                  );
                }
                const baseline = yield* Ref.get(lastScreenRef);
                const now = yield* Clock.currentTimeMillis;
                const admission = yield* Deferred.make<void>();
                const next: ActiveTerminalTurn = {
                  providerTurnId: currentTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  itemOrdinal: turnInput.providerTurnOrdinal * 100 + 1,
                  userPrompt: text,
                  // The bridge registers no MCP server, so the pull-request
                  // instructions would name tools the CLI never received.
                  prompt: `${text}\n\n${buildRuntimeInstructions({
                    harness: "Freebuff",
                    supportsMcpTooling: false,
                  })}`,
                  baseline,
                  output: "",
                  admission,
                  admissionDeadlineAt: now + ADMISSION_TIMEOUT_MS,
                  deadlineAt: now + TURN_TIMEOUT_MS,
                  latestScreen: baseline,
                  admissionScreen: undefined,
                  admissionWrites: 0,
                  lastAdmissionWriteAt: undefined,
                  submitted: false,
                  announced: false,
                  abortRequested: false,
                };
                yield* Ref.set(activeTurnRef, next);
                yield* publishSession("running");
                enqueueProcessEvent(processState, wakeQueue, { type: "screen", value: baseline });
                return next;
              }),
            );
            // The prompt is only written once the terminal reaches its chat
            // screen, so a send waits for that admission before returning.
            const admitted = yield* Deferred.await(turn.admission).pipe(
              Effect.timeoutOption(ADMISSION_TIMEOUT_MS + TURN_SETTLE_MS),
            );
            if (Option.isNone(admitted)) {
              yield* operationLock.withPermits(1)(
                Effect.gen(function* () {
                  const current = yield* Ref.get(activeTurnRef);
                  if (current?.providerTurnId !== turn.providerTurnId) return;
                  yield* Ref.set(activeTurnRef, undefined);
                  yield* dropUnsubmittedTurn(current, "Freebuff never reached its chat screen.");
                }),
              );
            }
          }),
        interruptTurn: (interruptInput) =>
          Effect.gen(function* () {
            const turn = yield* Ref.get(activeTurnRef);
            if (turn === undefined || turn.providerTurnId !== interruptInput.providerTurnId) return;
            // The CLI reads Escape as "stop what you are doing".
            yield* tryWriteProcess(process, ESC).pipe(Effect.ignore);
            turn.abortRequested = true;
            enqueueProcessEvent(processState, wakeQueue, {
              type: "screen",
              value: yield* Ref.get(lastScreenRef),
            });
          }),
        // The bridge writes one prompt at a time, so a follow-up steers nothing
        // and waits for the next turn instead.
        steerTurn: (steerInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
              driver: FREEBUFF_PROVIDER,
              providerThreadId: steerInput.providerThread.id,
            }),
          ),
        rollbackThread: (rollbackInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRollbackThreadError({
              driver: FREEBUFF_PROVIDER,
              providerThreadId: rollbackInput.providerThread.id,
              cause: new Error("Freebuff's terminal bridge cannot roll back a conversation."),
            }),
          ),
        forkThread: (forkInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterForkThreadError({
              driver: FREEBUFF_PROVIDER,
              providerThreadId: forkInput.sourceProviderThread.id,
              cause: new Error("Freebuff's terminal bridge cannot fork a conversation."),
            }),
          ),
        respondToRuntimeRequest: (requestInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
              driver: FREEBUFF_PROVIDER,
              requestId: requestInput.requestId,
              cause: new Error(
                "Freebuff's terminal bridge does not expose structured interactive requests to T3.",
              ),
            }),
          ),
        readThreadSnapshot: (snapshotInput) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
              driver: FREEBUFF_PROVIDER,
              providerThreadId: snapshotInput.providerThread.id,
              cause: new Error("Freebuff's terminal bridge cannot report a conversation snapshot."),
            }),
          ),
      };
      yield* Scope.addFinalizer(scope, Fiber.interrupt(monitorFiber).pipe(Effect.ignore));
      return runtime;
    });

  const isOpenSessionError = Schema.is(ProviderAdapter.ProviderAdapterOpenSessionError);

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: FREEBUFF_PROVIDER,
    getCapabilities: () => Effect.succeed(FreebuffProviderCapabilitiesV2),
    // Freebuff picks its model inside the TUI, so a selection can only land on
    // the next turn rather than switching the running session.
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: (input) =>
      openSession(input).pipe(
        Effect.mapError((cause) =>
          isOpenSessionError(cause)
            ? cause
            : new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: FREEBUFF_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
        ),
      ),
  });
}
