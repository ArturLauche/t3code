/**
 * Freebuff's terminal screen protocol.
 *
 * Freebuff ships no machine protocol: T3 spawns the CLI on a PTY and
 * reconstructs what happened from the rendered screen. Every rule that answers
 * "which screen is this?" and "which lines are the assistant's answer?" lives
 * here, away from the transport that owns the process, so the classifier and the
 * extractor can be exercised against captured screens alone.
 *
 * `provider/Layers/freebuffScreens.ts` holds the captured 0.1.6 output these
 * patterns were written against.
 */
const TERMINAL_COLUMNS = 160;
const TERMINAL_ROWS = 48;
// The classifier only reads the last `CLASSIFICATION_SCREEN_LINES`, and the
// extractor works from the text snapshot, so a scrollback much larger than the
// text window only costs a full re-stringification of the whole buffer on every
// parsed write.
export const TERMINAL_SCROLLBACK = 4_000;
const TERMINAL_TEXT_LINES = 4_000;
const CLASSIFICATION_SCREEN_LINES = 120;
const MAX_VISIBLE_TEXT_LENGTH = 200_000;

export type XtermTerminal = import("@xterm/headless").Terminal;

export { TERMINAL_COLUMNS, TERMINAL_ROWS };

/** Snapshot of the visible scrollback the screen rules reason about. */
export const terminalText = (terminal: XtermTerminal): string => {
  const buffer = terminal.buffer.active;
  const lines: Array<string> = [];
  const start = Math.max(0, buffer.length - TERMINAL_TEXT_LINES);
  for (let index = start; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return lines.join("\n").trimEnd();
};

export const screenTail = (screen: string): string =>
  screen.split("\n").slice(-CLASSIFICATION_SCREEN_LINES).join("\n");

export type FreebuffScreenState =
  | { readonly kind: "authentication"; readonly detail: string }
  | { readonly kind: "landing" }
  | { readonly kind: "chat" }
  | { readonly kind: "blocked"; readonly detail: string }
  | { readonly kind: "busy" }
  | { readonly kind: "unknown" };

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

/**
 * Chrome the unauthenticated CLI renders on its own.
 *
 * Every pattern is anchored to the whole line with an optional trailing
 * punctuation suffix. That is what the real TUI emits — `Open this URL in your
 * browser to login:` and `Waiting for login...` on 0.1.6 — and anchoring is
 * also what keeps a turn about authentication from failing: a user's prompt or
 * an answer that happens to mention signing in is part of the conversation, not
 * an overlay. See `freebuffScreens.ts` for the captured output.
 */
const AUTHENTICATION_SCREEN_PATTERNS = [
  /^\s*press\s+enter\s+to\s+login\b[^a-z]*$/iu,
  /^\s*open\s+this\s+url(?:\s+in\s+your\s+browser)?\s+to\s+login:?[^a-z]*$/iu,
  /^\s*waiting\s+for\s+login\b[^a-z]*$/iu,
  /^\s*(?:not\s+authenticated|authentication\s+required|login\s+required)\s*$/iu,
  /^\s*found\s+api\s+key\s+but\s+it\s+(?:appears\s+to\s+be|is)\s+invalid\s*$/iu,
] as const;

const BLOCKED_SCREEN_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /^\s*freebuff\s+is\s+already\s+running\s*$/iu,
    "Another Freebuff process is already using this account. Stop it before starting this thread.",
  ],
  [
    /^\s*only\s+one\s+freebuff\s+instance\s+is\s+allowed(?:\s+at\s+a\s+time)?\.?\s*$/iu,
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
const OVERLAY_MARKER_LINE =
  /^\s*(?:take\s+over|exit|load\s+and\s+run\s+these\?|close\s+the\s+other\s+instance)\b/iu;

export const hasFreebuffChatGate = (screen: string): boolean =>
  screenTail(screen)
    .split("\n")
    .map(stripTerminalBorder)
    .some((line) => CHAT_GATE_LINE.test(line));

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
    lastChatGate < 0 &&
    currentRegionLines.some((line) =>
      AUTHENTICATION_SCREEN_PATTERNS.some((linePattern) => linePattern.test(line)),
    )
  ) {
    return {
      kind: "authentication",
      detail:
        "Freebuff is not authenticated for this provider instance. Sign in from a terminal with the same Freebuff configuration, then retry.",
    };
  }
  const hasOverlayMarker = currentRegionLines.some((line) => OVERLAY_MARKER_LINE.test(line));
  for (const [pattern, detail] of BLOCKED_SCREEN_PATTERNS) {
    if (
      currentRegionLines.some((line) => pattern.test(line)) &&
      (lastChatGate < 0 || hasOverlayMarker)
    ) {
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

export const isBusyScreen = (screen: string): boolean => {
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
