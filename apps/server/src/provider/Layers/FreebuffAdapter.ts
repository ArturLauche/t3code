import * as NodeCrypto from "node:crypto";
import XtermHeadless from "@xterm/headless";
import {
  EventId,
  FREEBUFF_DEFAULT_MODEL,
  type FreebuffSettings,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
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
const isPtySpawnError = Schema.is(PtyAdapter.PtySpawnError);
const { Terminal } = XtermHeadless as unknown as {
  readonly Terminal: typeof import("@xterm/headless").Terminal;
};

const TURN_SETTLE_MS = 4_000;
const INTERRUPT_SETTLE_MS = 750;
const ADMISSION_ACTION_SETTLE_MS = 750;
const IDLE_SCREEN_POLL_MS = 100;
const ADMISSION_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 60 * 60_000;
const PROCESS_STOP_GRACE_MS = 2_000;
const TERMINAL_COLUMNS = 160;
const TERMINAL_ROWS = 48;
const TERMINAL_SCROLLBACK = 10_000;
const MAX_VISIBLE_TEXT_LENGTH = 200_000;
const MAX_RETAINED_TURNS = 100;
const CLASSIFICATION_SCREEN_LINES = 120;

type FreebuffProcessEvent =
  | { readonly type: "screen"; readonly value: string }
  | { readonly type: "exit"; readonly event: PtyAdapter.PtyExitEvent };

interface FreebuffProcessState {
  current: FreebuffProcessEvent | undefined;
  exited: boolean;
}

export type FreebuffScreenState =
  | { readonly kind: "authentication"; readonly detail: string }
  | { readonly kind: "landing" }
  | { readonly kind: "chat" }
  | { readonly kind: "blocked"; readonly detail: string }
  | { readonly kind: "busy" }
  | { readonly kind: "unknown" };

interface ActiveTerminalTurn {
  readonly id: TurnId;
  readonly itemId: RuntimeItemId;
  readonly userPrompt: string;
  readonly prompt: string;
  readonly baseline: string;
  output: string;
  readonly admission: Deferred.Deferred<void, ProviderAdapterError>;
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

interface FreebuffThreadTurn {
  readonly id: TurnId;
  readonly prompt: string;
  output?: string;
}

interface FreebuffSessionContext {
  readonly threadId: ThreadId;
  readonly process: PtyAdapter.PtyProcess;
  readonly processState: FreebuffProcessState;
  readonly wakeQueue: Queue.Queue<true>;
  readonly exit: Deferred.Deferred<PtyAdapter.PtyExitEvent>;
  readonly stopDeferred: Deferred.Deferred<void, ProviderAdapterError>;
  readonly terminal: XtermTerminal;
  readonly configDir: string;
  readonly scope: Scope.Closeable;
  session: ProviderSession;
  readonly turns: Array<FreebuffThreadTurn>;
  readonly activeTurn: Ref.Ref<ActiveTerminalTurn | undefined>;
  readonly lastScreen: Ref.Ref<string>;
  monitorFiber?: Fiber.Fiber<void, never>;
  readonly disposeTransport: () => void;
  stopping: boolean;
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

const stripTerminalBorder = (line: string): string => {
  const hasBoxBorder =
    /^[\t ]*[\u2500-\u257F\u2580-\u259F]/u.test(line) ||
    /[\u2500-\u257F\u2580-\u259F][\t ]*$/u.test(line);
  if (!hasBoxBorder) return line.trim();
  return line
    .replace(/^[\t ]*[\u2500-\u257F\u2580-\u259F]+/u, "")
    .replace(/[\t ]*[\u2500-\u257F\u2580-\u259F][\t ]*$/u, "")
    .replace(/^ ?/u, "");
};

const screenTail = (screen: string): string =>
  screen.split("\n").slice(-CLASSIFICATION_SCREEN_LINES).join("\n");

const AUTHENTICATION_SCREEN_PATTERNS = [
  /^\s*press\s+enter\s+to\s+login\s*(?:\.{3}|…)?\s*$/iu,
  /^\s*open\s+this\s+url(?:\s+in\s+your\s+browser)?\s+to\s+login\s*$/iu,
  /^\s*waiting\s+for\s+login\s*$/iu,
  /^\s*(?:not\s+authenticated|authentication\s+required|login\s+required)\s*$/iu,
  /^\s*found\s+api\s+key\s+but\s+it\s+(?:appears\s+to\s+be|is)\s+invalid\s*$/iu,
] as const;

const BLOCKED_SCREEN_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /^\s*freebuff\s+is\s+already\s+running\s*$/iu,
    "Another Freebuff process is already using this account. Stop it before starting this thread.",
  ],
  [
    /^\s*only\s+one\s+freebuff\s+instance\s+is\s+allowed\s*$/iu,
    "Another Freebuff process is already using this account. Stop it before starting this thread.",
  ],
  [
    /^\s*another\s+freebuff\s+instance\s+took\s+over\s+this\s+account\.?\s*$/iu,
    "Another Freebuff instance took over this account. Close the other instance, then retry.",
  ],
  [
    /^\s*only\s+one\s+cli\s+per\s+account\s+can\s+be\s+active\s+at\s+a\s+time\.?\s*$/iu,
    "Another Freebuff instance took over this account. Close the other instance, then retry.",
  ],
  [
    /^\s*freebuff\s+found\s+agent\s+files\s+in\s+this\s+repository\s+it\s+has\s+not\s+run\s+before:?\s*$/iu,
    "Freebuff needs approval before loading repository .agents or mcp.json files. Enable 'Trust repository agent files' in Freebuff settings, or trust the repository in Freebuff, then retry.",
  ],
  [
    /^\s*load\s+and\s+run\s+these\?\s*\[y\/N\]\s*$/iu,
    "Freebuff needs approval before loading repository .agents or mcp.json files. Enable 'Trust repository agent files' in Freebuff settings, or trust the repository in Freebuff, then retry.",
  ],
  [
    /^\s*free\s+mode\s+isn't\s+available\s+in\s+your\s+region\.?\s*$/iu,
    "Freebuff is not available from this network location.",
  ],
  [
    /^\s*(?:account\s+unavailable|your\s+account\s+has\s+been\s+suspended)\.?\s*$/iu,
    "This Freebuff account is unavailable.",
  ],
  [
    /^\s*(?:session\s+limit\s+reached|daily\s+freebuff\s+limit\s+reached)\.?\s*$/iu,
    "Freebuff's current usage limit has been reached.",
  ],
  [
    /^\s*(?:not\s+enough\s+freebucks|monthly\s+usage\s+limit\s+reached)\.?\s*$/iu,
    "This Freebuff account has reached its current usage limit.",
  ],
  [
    /^\s*too\s+many\s+freebuff\s+sessions\s+on\s+this\s+network\.?\s*$/iu,
    "Freebuff's per-network session limit has been reached.",
  ],
] as const;

const BUSY_SCREEN_LINE =
  /^(?:connecting|starting|loading|downloading|synchronizing|thinking|working|running|waiting|retrying)(?:(?:\.{3}|…)(?:\s+.*)?|\s+\d+\s*(?:ms|s|m|h)(?:\s+.*)?)?$/iu;
const HIGH_DEMAND_SCREEN_LINE =
  /^high\s+demand\s+[—-]\s+in\s+line,\s+starting\s+soon(?:\.{3}|…)?$/iu;
const CHAT_GATE_LINE = /^\s*enter\s+a\s+coding\s+task(?:\s+or\s+\/\s+for\s+commands)?\b/iu;

export function classifyFreebuffScreen(rawScreen: string): FreebuffScreenState {
  const screen = screenTail(rawScreen);
  const lines = screen.split("\n").map(stripTerminalBorder);
  let lastChatGate = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (CHAT_GATE_LINE.test(lines[index]?.trim() ?? "")) {
      lastChatGate = index;
      break;
    }
  }
  const regionStart =
    lastChatGate >= 0 ? Math.max(0, lastChatGate - 2) : Math.max(0, lines.length - 12);
  const currentRegionLines = lines.slice(regionStart);
  const currentRegion = currentRegionLines.join("\n");
  if (
    currentRegionLines.some((line) =>
      AUTHENTICATION_SCREEN_PATTERNS.some((pattern) => pattern.test(line)),
    )
  ) {
    return {
      kind: "authentication",
      detail:
        "Freebuff is not authenticated for this provider instance. Sign in from a terminal with the same Freebuff configuration, then retry.",
    };
  }
  for (const [pattern, detail] of BLOCKED_SCREEN_PATTERNS) {
    if (currentRegionLines.some((line) => pattern.test(line))) {
      return { kind: "blocked", detail };
    }
  }
  if (currentRegion.split("\n").some((line) => BUSY_SCREEN_LINE.test(line.trim()))) {
    return { kind: "busy" };
  }
  if (currentRegion.split("\n").some((line) => HIGH_DEMAND_SCREEN_LINE.test(line.trim()))) {
    return { kind: "busy" };
  }
  if (lastChatGate >= 0) return { kind: "chat" };
  if (/\bstart\s+coding\s+for\s+free\b/iu.test(currentRegion)) {
    return { kind: "landing" };
  }
  return { kind: "unknown" };
}

const isBusyScreen = (screen: string): boolean => {
  const lines = screenTail(screen).split("\n").map(stripTerminalBorder).filter(Boolean);
  return lines.slice(-3).some((line) => BUSY_SCREEN_LINE.test(line));
};

const promptNeedle = (prompt: string): string => {
  const lines = prompt.split(/\r?\n/u).filter((line) => line.trim());
  return (lines.at(-1) ?? prompt).trim().slice(-80);
};

const normalizeVisiblePromptText = (value: string): string => value.replace(/\s+/gu, " ").trim();

const USER_MESSAGE_HEADER = /^\[\d{1,2}:\d{2}(?:\s*[AP]M)?\](?:\s+(?:[!•].*)?)?$/iu;

const findTimestampPromptEnd = (lines: ReadonlyArray<string>, needle: string): number => {
  const normalizedNeedle = normalizeVisiblePromptText(needle);
  if (normalizedNeedle.length === 0) return -1;
  let matchingEnd = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (!USER_MESSAGE_HEADER.test(lines[index]?.trim() ?? "")) continue;
    let bubbleEnd = index + 1;
    while (bubbleEnd < lines.length && !USER_MESSAGE_HEADER.test(lines[bubbleEnd]?.trim() ?? "")) {
      bubbleEnd += 1;
    }
    for (let end = index + 2; end <= bubbleEnd; end += 1) {
      const bubble = normalizeVisiblePromptText(lines.slice(index + 1, end).join(" "));
      if (bubble.includes(normalizedNeedle)) {
        matchingEnd = end;
        break;
      }
    }
  }
  return matchingEnd;
};

const findFirstPromptLine = (
  lines: ReadonlyArray<string>,
  needle: string,
  start: number,
): number => {
  let firstMatch = -1;
  for (let index = start; index < lines.length; index += 1) {
    if (!lines[index]?.includes(needle)) continue;
    if (firstMatch < 0) firstMatch = index;
    if (/^\s*(?:>|❯)\s+/u.test(lines[index] ?? "")) return index;
  }
  return firstMatch;
};

const findLastMarkedPromptLine = (
  lines: ReadonlyArray<string>,
  needle: string,
  end: number,
): number => {
  for (let index = Math.min(end, lines.length) - 1; index >= 0; index -= 1) {
    if (lines[index]?.includes(needle) && /^\s*(?:>|❯)\s+/u.test(lines[index] ?? "")) {
      return index;
    }
  }
  return -1;
};

const isTerminalChrome = (line: string): boolean => {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return [
    /^codebuff(?:hq)?\b/iu,
    /^freebuff\b/iu,
    BUSY_SCREEN_LINE,
    /^(?:press )?esc(?:ape)?(?: to)? (?:interrupt|stop)/iu,
    /^\? (?:for )?(?:shortcuts|help)/iu,
    /^(?:model|context|branch|tokens?)\s*[:•]/iu,
    /^(?:cwd|directory)\s*[:•]/iu,
    /^enter\s+a\s+coding\s+task(?:\s+or\s+\/\s+for\s+commands)?\b/iu,
  ].some((pattern) => pattern.test(trimmed));
};

const candidateAssistantLines = (input: {
  readonly baseline: string;
  readonly current: string;
  readonly prompt: string;
}): ReadonlyArray<string> => {
  const currentLines = input.current.split("\n").map(stripTerminalBorder);
  const needle = promptNeedle(input.prompt);
  const timestampPromptEnd = findTimestampPromptEnd(currentLines, needle);
  if (timestampPromptEnd >= 0) return currentLines.slice(timestampPromptEnd);

  const lastChatGate = currentLines.findLastIndex((line) => CHAT_GATE_LINE.test(line));
  const searchStart = lastChatGate >= 0 ? lastChatGate + 1 : 0;
  let promptIndex = -1;
  if (lastChatGate >= 0) {
    promptIndex = findLastMarkedPromptLine(currentLines, needle, lastChatGate + 1);
    if (promptIndex < 0) {
      promptIndex = findFirstPromptLine(currentLines, needle, searchStart);
    }
  } else {
    promptIndex = findFirstPromptLine(currentLines, needle, 0);
  }
  if (promptIndex < 0 && searchStart > 0) {
    promptIndex = findLastMarkedPromptLine(currentLines, needle, currentLines.length);
  }
  if (promptIndex < 0 && searchStart > 0) {
    promptIndex = findFirstPromptLine(currentLines, needle, 0);
  }
  if (promptIndex >= 0) return currentLines.slice(promptIndex + 1);

  const baselineLines = input.baseline.split("\n").map(stripTerminalBorder);
  let firstChangedLine = 0;
  while (
    firstChangedLine < baselineLines.length &&
    currentLines[firstChangedLine] === baselineLines[firstChangedLine]
  ) {
    firstChangedLine += 1;
  }
  return currentLines.slice(firstChangedLine);
};

const RUNTIME_INSTRUCTION_BLOCK =
  /<(?:runtime_info|pull_request_linking)>[\s\S]*?(?:<\/(?:runtime_info|pull_request_linking)>|$)/giu;
const ATTACHMENT_CONTEXT_BLOCK =
  /\[(?:Attached (?:file|image|text) |Pasted text )[^\]\n]*\bis saved at:\s[^\]\n]+\]/giu;
const CAPTURED_WINDOW_CONTEXT_BLOCK =
  /Untrusted captured-window data follows as JSON\.[\s\S]*?End untrusted captured-window data\./giu;

const stripInternalPromptContext = (text: string): string =>
  text
    .replace(RUNTIME_INSTRUCTION_BLOCK, "")
    .replace(ATTACHMENT_CONTEXT_BLOCK, "")
    .replace(CAPTURED_WINDOW_CONTEXT_BLOCK, "");

export const extractVisibleAssistantText = (input: {
  readonly baseline: string;
  readonly current: string;
  readonly prompt: string;
}): string => {
  const text = stripInternalPromptContext(
    candidateAssistantLines(input)
      .filter((line) => !isTerminalChrome(line))
      .join("\n")
      .trim(),
  ).trim();
  return text.slice(0, MAX_VISIBLE_TEXT_LENGTH);
};

export const mergeVisibleAssistantText = (previous: string, next: string): string => {
  const prior = previous.trim();
  const current = next.trim();
  if (!current || prior === current || prior.endsWith(current)) return prior;
  if (current.startsWith(prior)) return current.slice(0, MAX_VISIBLE_TEXT_LENGTH);

  const priorLines = prior.split("\n");
  const currentLines = current.split("\n");
  const maxLineOverlap = Math.min(priorLines.length, currentLines.length);
  for (let overlap = maxLineOverlap; overlap > 0; overlap -= 1) {
    if (priorLines.slice(-overlap).join("\n") === currentLines.slice(0, overlap).join("\n")) {
      return [...priorLines, ...currentLines.slice(overlap)]
        .join("\n")
        .slice(0, MAX_VISIBLE_TEXT_LENGTH);
    }
  }

  const maxCharacterOverlap = Math.min(prior.length, current.length, 4_096);
  for (let overlap = maxCharacterOverlap; overlap > 0; overlap -= 1) {
    if (prior.endsWith(current.slice(0, overlap))) {
      return `${prior}${current.slice(overlap)}`.slice(0, MAX_VISIBLE_TEXT_LENGTH);
    }
  }
  return `${prior}\n${current}`.slice(0, MAX_VISIBLE_TEXT_LENGTH);
};

const encodePrompt = (prompt: string, bracketedPaste: boolean): string => {
  if (bracketedPaste) return `\u001b[200~${prompt}\u001b[201~\r`;
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

const tryKillProcess = (process: PtyAdapter.PtyProcess, signal: string) =>
  Effect.try({
    try: () => {
      process.kill(signal);
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

const isLegacyTerminalBridgeCursor = (value: unknown): boolean => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1 && typeof record.configDir === "string";
};

const enqueueProcessEvent = (
  state: FreebuffProcessState,
  wakeQueue: Queue.Queue<true>,
  event: FreebuffProcessEvent,
): void => {
  if (state.exited && event.type === "screen") return;
  if (state.current?.type === "exit") return;
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

  const processError = (
    threadId: ThreadId,
    detail: string,
    cause?: unknown,
  ): ProviderAdapterProcessError =>
    new ProviderAdapterProcessError({
      provider: FREEBUFF_PROVIDER,
      threadId,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const requestError = (detail: string): ProviderAdapterRequestError =>
    new ProviderAdapterRequestError({
      provider: FREEBUFF_PROVIDER,
      method: "turn/send",
      detail,
    });

  const startProcessError = (threadId: ThreadId, cause: unknown): ProviderAdapterProcessError =>
    processError(
      threadId,
      isPtySpawnError(cause) && cause.adapter === "unavailable"
        ? "Freebuff requires the server's local PTY adapter, but it is unavailable."
        : "Failed to start the Freebuff terminal process.",
      cause,
    );

  const finishTurn = (
    context: FreebuffSessionContext,
    state: "completed" | "failed" | "cancelled",
    detail?: string,
    submissionError?: ProviderAdapterError,
    options?: { readonly extractLatest?: boolean },
  ) =>
    Effect.gen(function* () {
      const active = yield* Ref.modify(
        context.activeTurn,
        (current) => [current, undefined] as const,
      );
      if (!active) return;

      if (!active.announced && submissionError) {
        yield* Deferred.fail(active.admission, submissionError).pipe(Effect.ignore);
      }

      if (active.announced) {
        if (options?.extractLatest !== false) {
          active.output = mergeVisibleAssistantText(
            active.output,
            extractVisibleAssistantText({
              baseline: active.baseline,
              current: active.latestScreen,
              prompt: active.userPrompt,
            }),
          );
        }
        const output = active.output;
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
      } else if (state === "failed" && detail) {
        yield* publish({
          ...(yield* eventStamp(context.threadId)),
          type: "runtime.error",
          payload: { message: detail, class: "provider_error" },
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

  const failTurn = (
    context: FreebuffSessionContext,
    detail: string,
    submissionError: ProviderAdapterError,
    options?: { readonly extractLatest?: boolean },
  ) => finishTurn(context, "failed", detail, submissionError, options);

  const failTurnOnScreenGate = (context: FreebuffSessionContext, detail: string) =>
    failTurn(context, detail, requestError(detail), { extractLatest: false });

  const terminateProcess = (context: FreebuffSessionContext) =>
    Effect.gen(function* () {
      if (context.processState.exited) return;
      yield* tryKillProcess(context.process, "SIGTERM").pipe(
        Effect.mapError((cause) =>
          processError(context.threadId, "Failed to stop the Freebuff terminal process.", cause),
        ),
      );
      const gracefulExit = yield* Deferred.await(context.exit).pipe(
        Effect.timeoutOption(PROCESS_STOP_GRACE_MS),
      );
      if (gracefulExit._tag === "Some") return;
      yield* tryKillProcess(context.process, "SIGKILL").pipe(
        Effect.mapError((cause) =>
          processError(
            context.threadId,
            "Failed to force-stop the Freebuff terminal process.",
            cause,
          ),
        ),
      );
      const forcedExit = yield* Deferred.await(context.exit).pipe(
        Effect.timeoutOption(PROCESS_STOP_GRACE_MS),
      );
      if (forcedExit._tag === "None") {
        return yield* processError(
          context.threadId,
          "The Freebuff terminal did not exit after SIGKILL.",
        );
      }
    });

  const claimSessionForStop = (context: FreebuffSessionContext) =>
    operationLock.withPermits(1)(
      Effect.sync(() => {
        if (context.stopping || sessions.get(context.threadId) !== context) return false;
        context.stopping = true;
        context.stopped = true;
        return true;
      }),
    );

  const stopSessionInternal = (context: FreebuffSessionContext, reason: string) =>
    Effect.gen(function* () {
      const termination = yield* terminateProcess(context).pipe(Effect.result);
      if (Result.isFailure(termination)) {
        context.session = {
          ...context.session,
          status: "error",
          lastError: termination.failure.message,
          updatedAt: yield* nowIso,
        };
        yield* publish({
          ...(yield* eventStamp(context.threadId)),
          type: "session.state.changed",
          payload: { state: "error", reason: termination.failure.message },
        });
        yield* finishTurn(context, "failed", termination.failure.message, termination.failure).pipe(
          Effect.ignore,
        );
        // Keep the transport and exit listener alive after a failed stop so
        // a later stopAll/stopSession attempt can observe the eventual exit
        // and retry cleanup. The tombstone also prevents an overlapping start.
        context.stopping = false;
        return yield* termination.failure;
      }

      if (context.monitorFiber) {
        yield* Fiber.interrupt(context.monitorFiber).pipe(Effect.ignore);
      }
      yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
      yield* finishTurn(
        context,
        "cancelled",
        reason,
        requestError(`Freebuff turn interrupted before submission: ${reason}`),
      ).pipe(Effect.ignore);
      context.disposeTransport();
      const {
        activeTurnId: _activeTurnId,
        lastError: _lastError,
        ...sessionWithoutTurn
      } = context.session;
      context.session = {
        ...sessionWithoutTurn,
        status: "closed",
        updatedAt: yield* nowIso,
      };
      sessions.delete(context.threadId);
      yield* publish({
        ...(yield* eventStamp(context.threadId)),
        type: "session.exited",
        payload: { reason, recoverable: false, exitKind: "graceful" },
      });
    }).pipe(Effect.uninterruptible);

  const stopSessionAndPublishResult = (context: FreebuffSessionContext, reason: string) =>
    stopSessionInternal(context, reason).pipe(
      Effect.tap(() => Deferred.succeed(context.stopDeferred, undefined)),
      Effect.tapError((error) => Deferred.fail(context.stopDeferred, error)),
    );

  // Once a stop is claimed, keep the claim/result transition uninterruptible so
  // concurrent callers always observe the same terminal outcome.
  const claimAndStopSession = (context: FreebuffSessionContext, reason: string) =>
    claimSessionForStop(context).pipe(
      Effect.flatMap((claimed) =>
        claimed
          ? stopSessionAndPublishResult(context, reason)
          : Deferred.await(context.stopDeferred),
      ),
      Effect.uninterruptible,
    );

  const submitActiveTurn = (context: FreebuffSessionContext, active: ActiveTerminalTurn) =>
    Effect.gen(function* () {
      const writeResult = yield* tryWriteProcess(
        context.process,
        encodePrompt(active.prompt, context.terminal.modes.bracketedPasteMode),
      ).pipe(
        Effect.matchEffect({
          onFailure: (cause) => {
            const error = processError(
              context.threadId,
              "Failed to write the prompt to Freebuff.",
              cause,
            );
            return failTurn(context, error.message, error).pipe(Effect.as("failed" as const));
          },
          onSuccess: () => Effect.succeed("written" as const),
        }),
      );
      if (writeResult === "failed") return;
      active.submitted = true;
      active.announced = true;
      context.turns.push({ id: active.id, prompt: active.userPrompt });
      if (context.turns.length > MAX_RETAINED_TURNS) context.turns.shift();
      yield* publish({
        ...(yield* eventStamp(context.threadId)),
        type: "turn.started",
        turnId: active.id,
        payload: { model: context.session.model },
      });
      yield* publish({
        ...(yield* eventStamp(context.threadId)),
        type: "item.started",
        turnId: active.id,
        itemId: active.itemId,
        payload: { itemType: "assistant_message", status: "inProgress" },
      });
      yield* Deferred.succeed(active.admission, undefined);
    });

  const admitActiveTurn = (
    context: FreebuffSessionContext,
    active: ActiveTerminalTurn,
    screen: string,
    now: number,
  ) =>
    Effect.gen(function* () {
      if (active.admissionWrites >= 2 || active.admissionScreen === screen) return;
      if (
        active.lastAdmissionWriteAt !== undefined &&
        now - active.lastAdmissionWriteAt < ADMISSION_ACTION_SETTLE_MS
      ) {
        return;
      }
      const writeResult = yield* tryWriteProcess(context.process, "\r").pipe(
        Effect.matchEffect({
          onFailure: (cause) => {
            const error = processError(
              context.threadId,
              "Failed to start the Freebuff session.",
              cause,
            );
            return failTurn(context, error.message, error).pipe(Effect.as("failed" as const));
          },
          onSuccess: () => Effect.succeed("written" as const),
        }),
      );
      if (writeResult === "failed") return;
      active.admissionScreen = screen;
      active.admissionWrites += 1;
      active.lastAdmissionWriteAt = now;
    });

  const handleUnexpectedExit = (context: FreebuffSessionContext, event: PtyAdapter.PtyExitEvent) =>
    Effect.gen(function* () {
      if (context.stopped) return;
      context.processState.exited = true;
      const reason =
        event.signal === null
          ? `Freebuff terminal exited with code ${event.exitCode}.`
          : `Freebuff terminal exited after signal ${event.signal}.`;
      yield* finishTurn(context, "failed", reason, processError(context.threadId, reason));
      context.stopped = true;
      sessions.delete(context.threadId);
      context.disposeTransport();
      context.session = { ...context.session, status: "error", updatedAt: yield* nowIso };
      yield* publish({
        ...(yield* eventStamp(context.threadId)),
        type: "session.exited",
        payload: {
          reason,
          recoverable: false,
          exitKind: event.exitCode === 0 ? "graceful" : "error",
        },
      });
      yield* Effect.forkDetach(Scope.close(context.scope, Exit.void).pipe(Effect.ignore));
    });

  const processScreenEvent = (context: FreebuffSessionContext, screen: string) =>
    Effect.gen(function* () {
      if (context.stopped) return;
      const renderedScreen = terminalText(context.terminal);
      const rawScreenState = classifyFreebuffScreen(screenTail(screen));
      const currentScreen = renderedScreen.length > 0 ? renderedScreen : screen;
      const now = yield* Clock.currentTimeMillis;
      const active = yield* Ref.get(context.activeTurn);
      yield* Ref.set(context.lastScreen, currentScreen);
      if (active) {
        active.latestScreen = currentScreen;
        if (now >= active.deadlineAt) {
          return yield* failTurn(
            context,
            "The Freebuff turn exceeded its maximum duration.",
            requestError("The Freebuff turn exceeded its maximum duration before submission."),
          );
        }
      }

      const screenState =
        rawScreenState.kind === "unknown"
          ? classifyFreebuffScreen(screenTail(currentScreen))
          : rawScreenState;
      if (screenState.kind === "authentication" || screenState.kind === "blocked") {
        if (active) {
          return yield* failTurnOnScreenGate(context, screenState.detail);
        }
        context.session = {
          ...context.session,
          status: "error",
          lastError: screenState.detail,
          updatedAt: yield* nowIso,
        };
        yield* publish({
          ...(yield* eventStamp(context.threadId)),
          type: "runtime.warning",
          payload: { message: screenState.detail },
        });
        return;
      }
      if (active && !active.submitted && now >= active.admissionDeadlineAt) {
        return yield* failTurn(
          context,
          "Freebuff did not reach its chat screen in time.",
          requestError("Freebuff did not reach its chat screen in time."),
        );
      }
      if (active?.submitted) {
        active.output = mergeVisibleAssistantText(
          active.output,
          extractVisibleAssistantText({
            baseline: active.baseline,
            current: renderedScreen || currentScreen,
            prompt: active.userPrompt,
          }),
        );
      }
      if (!active || active.abortRequested) return;
      if (!active.submitted) {
        if (screenState.kind === "landing") {
          return yield* admitActiveTurn(context, active, currentScreen, now);
        }
        if (screenState.kind === "chat") {
          return yield* submitActiveTurn(context, active);
        }
        return;
      }
    });

  const processSettle = (context: FreebuffSessionContext) =>
    Effect.gen(function* () {
      if (context.stopped) return;
      const active = yield* Ref.get(context.activeTurn);
      if (!active) return;
      const renderedScreen = terminalText(context.terminal);
      if (renderedScreen.length > 0) active.latestScreen = renderedScreen;
      const now = yield* Clock.currentTimeMillis;
      if (now >= active.deadlineAt) {
        return yield* failTurn(
          context,
          "The Freebuff turn exceeded its maximum duration.",
          requestError("The Freebuff turn exceeded its maximum duration before submission."),
        );
      }
      const screenState = classifyFreebuffScreen(screenTail(active.latestScreen));
      if (screenState.kind === "authentication" || screenState.kind === "blocked") {
        return yield* failTurnOnScreenGate(context, screenState.detail);
      }
      if (active.abortRequested) {
        if (!isBusyScreen(active.latestScreen)) {
          const detail = "The Freebuff turn was interrupted.";
          return yield* finishTurn(
            context,
            "cancelled",
            detail,
            requestError(`${detail} It was interrupted before prompt submission.`),
          );
        }
        return;
      }
      if (!active.submitted) {
        if (now >= active.admissionDeadlineAt) {
          return yield* failTurn(
            context,
            "Freebuff did not reach its chat screen in time.",
            requestError("Freebuff did not reach its chat screen in time."),
          );
        }
        if (screenState.kind === "landing") {
          return yield* admitActiveTurn(context, active, active.latestScreen, now);
        }
        if (screenState.kind === "chat") {
          return yield* submitActiveTurn(context, active);
        }
        return;
      }
      if (isBusyScreen(active.latestScreen)) return;
      active.output = mergeVisibleAssistantText(
        active.output,
        extractVisibleAssistantText({
          baseline: active.baseline,
          current: active.latestScreen,
          prompt: active.userPrompt,
        }),
      );
      if (active.output.length > 0) {
        return yield* finishTurn(context, "completed");
      }
    });

  const monitorUnexpectedFailure = (context: FreebuffSessionContext, cause: unknown) =>
    operationLock.withPermits(1)(
      Effect.gen(function* () {
        if (context.stopped) return;
        const detail = "The Freebuff terminal monitor stopped unexpectedly.";
        context.stopping = true;
        context.stopped = true;
        yield* finishTurn(context, "failed", detail, processError(context.threadId, detail, cause));
        const termination = yield* terminateProcess(context).pipe(Effect.result);
        if (Result.isFailure(termination)) {
          context.stopping = false;
          context.session = {
            ...context.session,
            status: "error",
            lastError: termination.failure.message,
            updatedAt: yield* nowIso,
          };
          yield* publish({
            ...(yield* eventStamp(context.threadId)),
            type: "session.state.changed",
            payload: { state: "error", reason: termination.failure.message },
          });
          yield* Effect.logWarning("Freebuff terminal monitor stopped.", { cause });
          return;
        }
        sessions.delete(context.threadId);
        context.disposeTransport();
        context.session = { ...context.session, status: "error", updatedAt: yield* nowIso };
        yield* publish({
          ...(yield* eventStamp(context.threadId)),
          type: "session.exited",
          payload: { reason: detail, recoverable: false, exitKind: "error" },
        });
        yield* Effect.logWarning("Freebuff terminal monitor stopped.", { cause });
        yield* Effect.forkDetach(Scope.close(context.scope, Exit.void).pipe(Effect.ignore));
      }).pipe(Effect.uninterruptible),
    );

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (startInput) =>
    operationLock.withPermits(1)(
      Effect.gen(function* () {
        if (startInput.provider !== undefined && startInput.provider !== FREEBUFF_PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: FREEBUFF_PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${FREEBUFF_PROVIDER}' but received '${startInput.provider}'.`,
          });
        }
        const existing = Array.from(sessions.values())[0];
        if (existing) {
          return yield* new ProviderAdapterRequestError({
            provider: FREEBUFF_PROVIDER,
            method: "session/start",
            detail: `Freebuff allows one active session per provider instance. Stop the existing session for thread '${existing.threadId}' first.`,
          });
        }
        const hasLegacyCursor =
          startInput.resumeCursor !== undefined &&
          startInput.resumeCursor !== null &&
          isLegacyTerminalBridgeCursor(startInput.resumeCursor);
        if (
          startInput.resumeCursor !== undefined &&
          startInput.resumeCursor !== null &&
          !hasLegacyCursor
        ) {
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
        if (
          startInput.sandboxMode !== undefined &&
          startInput.sandboxMode !== "danger-full-access"
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: FREEBUFF_PROVIDER,
            operation: "startSession",
            issue: "Freebuff's terminal bridge cannot enforce a restricted sandbox mode.",
          });
        }
        if (startInput.approvalPolicy !== undefined && startInput.approvalPolicy !== "never") {
          return yield* new ProviderAdapterValidationError({
            provider: FREEBUFF_PROVIDER,
            operation: "startSession",
            issue: "Freebuff's terminal bridge cannot route interactive approval requests to T3.",
          });
        }

        const cwd = startInput.cwd?.trim() || input.defaultCwd;
        const sessionScope = yield* Scope.make("sequential");
        yield* Scope.addFinalizer(adapterScope, Scope.close(sessionScope, Exit.void));
        const launchArgs = [...tokenizeCliArgs(input.settings.launchArgs)];
        const trustAgentsIndex = launchArgs.indexOf("--trust-agents");
        if (input.settings.trustRepositoryAgents) {
          if (trustAgentsIndex < 0) launchArgs.push("--trust-agents");
        } else if (trustAgentsIndex >= 0) {
          launchArgs.splice(trustAgentsIndex, 1);
        }
        launchArgs.push("--cwd", cwd);
        const processEnvironment: NodeJS.ProcessEnv = {
          ...input.environment,
          FREEBUFF_CONFIG_DIR: input.configDir,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        };
        const resolvedCommand = yield* resolveSpawnCommand(
          expandHomePath(input.settings.binaryPath || "freebuff"),
          launchArgs,
          { env: processEnvironment },
        ).pipe(
          Effect.mapError((cause) =>
            processError(startInput.threadId, "Failed to resolve the Freebuff CLI command.", cause),
          ),
        );
        const ptyCommand = resolvedCommand.shell
          ? {
              shell: processEnvironment.ComSpec ?? "cmd.exe",
              args: [
                "/d",
                "/s",
                "/c",
                [resolvedCommand.command, ...resolvedCommand.args].join(" "),
              ],
            }
          : { shell: resolvedCommand.command, args: [...resolvedCommand.args] };
        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: FREEBUFF_PROVIDER,
          providerInstanceId: input.instanceId,
          status: "connecting",
          model: startInput.modelSelection?.model ?? FREEBUFF_DEFAULT_MODEL,
          runtimeMode: startInput.runtimeMode,
          cwd,

          threadId: startInput.threadId,
          ...(hasLegacyCursor ? { resumeCursor: null } : {}),
          createdAt,
          updatedAt: createdAt,
        };
        const processState: FreebuffProcessState = { current: undefined, exited: false };
        let disposeTransport = () => {};
        const wakeQueue = yield* Queue.bounded<true>(1);
        const exit = yield* Deferred.make<PtyAdapter.PtyExitEvent>();
        const process = yield* ptyAdapter
          .spawn({
            ...ptyCommand,
            cwd,
            cols: TERMINAL_COLUMNS,
            rows: TERMINAL_ROWS,
            env: processEnvironment,
          })
          .pipe(Effect.mapError((cause) => startProcessError(startInput.threadId, cause)));
        yield* Scope.addFinalizer(
          sessionScope,
          Effect.suspend(() =>
            (processState.exited
              ? Effect.void
              : tryKillProcess(process, "SIGKILL").pipe(Effect.ignore)
            ).pipe(Effect.andThen(Effect.sync(() => disposeTransport()))),
          ),
        );
        const terminal = new Terminal({
          allowProposedApi: true,
          cols: TERMINAL_COLUMNS,
          rows: TERMINAL_ROWS,
          scrollback: TERMINAL_SCROLLBACK,
        });
        const removeDataListener = process.onData((data) => {
          terminal.write(data);
          enqueueProcessEvent(processState, wakeQueue, { type: "screen", value: data });
        });
        const parsedListener = terminal.onWriteParsed(() => {
          enqueueProcessEvent(processState, wakeQueue, {
            type: "screen",
            value: terminalText(terminal),
          });
        });
        const removeExitListener = process.onExit((event) => {
          processState.exited = true;
          Deferred.doneUnsafe(exit, Effect.succeed(event));
          enqueueProcessEvent(processState, wakeQueue, { type: "exit", event });
        });
        const activeTurn = yield* Ref.make<ActiveTerminalTurn | undefined>(undefined);
        const lastScreen = yield* Ref.make("");
        const stopDeferred = yield* Deferred.make<void, ProviderAdapterError>();
        let transportDisposed = false;
        disposeTransport = () => {
          if (transportDisposed) return;
          transportDisposed = true;
          removeDataListener();
          parsedListener.dispose();
          removeExitListener();
          terminal.dispose();
        };
        const context: FreebuffSessionContext = {
          threadId: startInput.threadId,
          process,
          processState,
          wakeQueue,
          exit,
          stopDeferred,
          terminal,
          configDir: input.configDir,
          scope: sessionScope,
          session,
          turns: [],
          activeTurn,
          lastScreen,
          disposeTransport,
          stopping: false,
          stopped: false,
        };
        const monitor = Effect.gen(function* () {
          while (!context.stopped) {
            const active = yield* Ref.get(activeTurn);
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
              yield* operationLock.withPermits(1)(processSettle(context));
              continue;
            }
            const event = processState.current;
            processState.current = undefined;
            if (!event) continue;
            yield* operationLock.withPermits(1)(
              event.type === "exit"
                ? handleUnexpectedExit(context, event.event)
                : processScreenEvent(context, event.value),
            );
          }
        }).pipe(Effect.catchCause((cause) => monitorUnexpectedFailure(context, cause)));

        sessions.set(startInput.threadId, context);
        context.monitorFiber = yield* monitor.pipe(Effect.forkIn(sessionScope));
        if (context.stopped || processState.exited) {
          sessions.delete(startInput.threadId);
          yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
          context.disposeTransport();
          return yield* processError(
            startInput.threadId,
            "The Freebuff terminal exited while the session was starting.",
          );
        }
        yield* publish({
          ...(yield* eventStamp(startInput.threadId)),
          type: "session.started",
          payload: { message: "Connected to the Freebuff terminal bridge." },
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
              conversationResume: false,
              attachmentTransport: "prompt-paths",
              localOnly: true,
            },
          },
        });
        yield* emitSessionState(context, "ready");
        return context.session;
      }),
    );

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (turnInput) =>
    Effect.gen(function* () {
      if (turnInput.interactionMode === "plan") {
        return yield* new ProviderAdapterValidationError({
          provider: FREEBUFF_PROVIDER,
          operation: "sendTurn",
          issue: "Freebuff's current CLI does not expose a separate plan mode.",
        });
      }
      const text = turnInput.input?.trim();
      if (!text) {
        return yield* new ProviderAdapterValidationError({
          provider: FREEBUFF_PROVIDER,
          operation: "sendTurn",
          issue: "Freebuff requires a non-empty prompt or attachment context.",
        });
      }
      const active = yield* operationLock.withPermits(1)(
        Effect.gen(function* () {
          const context = yield* requireSession(turnInput.threadId);
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
          const now = yield* Clock.currentTimeMillis;
          const admission = yield* Deferred.make<void, ProviderAdapterError>();
          const nextActive: ActiveTerminalTurn = {
            id: turnId,
            itemId,
            userPrompt: text,
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
          yield* Ref.set(context.activeTurn, nextActive);
          context.session = {
            ...context.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
          };
          yield* publish({
            ...(yield* eventStamp(turnInput.threadId)),
            type: "session.state.changed",
            payload: { state: "running" },
          });
          enqueueProcessEvent(context.processState, context.wakeQueue, {
            type: "screen",
            value: baseline,
          });
          return nextActive;
        }),
      );
      const admissionResult = yield* Deferred.await(active.admission).pipe(
        Effect.timeoutOption(ADMISSION_TIMEOUT_MS + TURN_SETTLE_MS),
        Effect.onInterrupt(() =>
          operationLock.withPermits(1)(
            Effect.gen(function* () {
              const context = sessions.get(turnInput.threadId);
              if (!context) return;
              const current = yield* Ref.get(context.activeTurn);
              if (current?.id !== active.id) return;
              yield* finishTurn(
                context,
                "cancelled",
                "The Freebuff turn send was interrupted.",
                requestError("The Freebuff turn send was interrupted before prompt submission."),
              ).pipe(Effect.ignore);
            }),
          ),
        ),
      );
      if (Option.isNone(admissionResult)) {
        const error = requestError("Freebuff did not reach its chat screen in time.");
        yield* operationLock.withPermits(1)(
          Effect.gen(function* () {
            const context = sessions.get(turnInput.threadId);
            if (!context) return;
            const current = yield* Ref.get(context.activeTurn);
            if (current?.id !== active.id) return;
            yield* finishTurn(context, "failed", error.message, error).pipe(Effect.ignore);
          }),
        );
        return yield* error;
      }
      return {
        threadId: turnInput.threadId,
        turnId: active.id,
        resumeCursor: null,
      };
    });

  const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
    threadId,
    turnId,
  ) =>
    operationLock.withPermits(1)(
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const active = yield* Ref.get(context.activeTurn);
        if (!active || (turnId !== undefined && active.id !== turnId)) return;
        yield* tryWriteProcess(context.process, "\u001b").pipe(
          Effect.mapError((cause) =>
            processError(threadId, "Failed to interrupt the Freebuff turn.", cause),
          ),
        );
        active.abortRequested = true;
        enqueueProcessEvent(context.processState, context.wakeQueue, {
          type: "screen",
          value: yield* Ref.get(context.lastScreen),
        });
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
    operationLock.withPermits(1)(
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
      }),
    );

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
    Effect.gen(function* () {
      const context = sessions.get(threadId);
      if (!context) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: FREEBUFF_PROVIDER,
          threadId,
        });
      }
      yield* claimAndStopSession(context, "Session stopped.");
    });

  const listSessions = () =>
    Effect.sync(() => Array.from(sessions.values(), (context) => ({ ...context.session })));
  const hasSession = (threadId: ThreadId) => Effect.sync(() => sessions.has(threadId));
  const stopAll = () =>
    Effect.forEach(
      Array.from(sessions.values()),
      (context) => claimAndStopSession(context, "Provider stopped."),
      { discard: true },
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
