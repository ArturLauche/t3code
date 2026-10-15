/**
 * Live output-token rate for a turn that is actively generating assistant
 * tokens. Providers report a cumulative per-response `outputTokens` on each
 * `provider_turn.updated` (#8144), so the rate is the slope of that counter
 * over a short window rather than a whole-turn average.
 *
 * The projection keeps only the latest usage per turn, so samples are pushed in
 * as they are observed and pruned here. Idle gaps (tool execution, waiting on
 * the provider) are excluded from the numerator's time so a slow panel does not
 * drag a fast burst down to a lifetime average, and a counter reset marks a new
 * assistant response rather than negative progress.
 */

/** Rolling window the rate is measured over. Long enough to be stable, short
    enough to track bursts and stalls. */
const WINDOW_MS = 2_500;
/** Ignore gaps longer than this when summing active generation time; a gap past
    it is a tool call or a provider pause, not generation the user waits on. */
const MAX_GENERATE_GAP_MS = 1_500;
/** No new tokens for this long reads as "not generating right now". */
const STALL_MS = 900;
/** Upper bound on retained samples; keeps the window array tiny under backlogs. */
const MAX_SAMPLES = 64;

interface TokenRateSample {
  readonly at: number;
  readonly outputTokens: number;
}

export interface OutputTokenRateTracker {
  /** Record an observed cumulative output-token count and when it was seen. */
  push(observedAtMs: number, outputTokens: number): void;
  /** Rolling tokens-per-second, or null when not enough generating data or the
      turn has gone quiet. `nowMs` is on the same clock as the pushed samples. */
  tokensPerSecond(nowMs: number): number | null;
  /** Drop all state so a fresh turn or thread starts clean. */
  reset(): void;
}

export function createOutputTokenRateTracker(): OutputTokenRateTracker {
  let window: TokenRateSample[] = [];

  const reset = () => {
    window = [];
  };

  const push = (observedAtMs: number, outputTokens: number) => {
    if (!Number.isFinite(observedAtMs) || !Number.isFinite(outputTokens) || outputTokens < 0) {
      return;
    }
    const last = window.at(-1);
    if (last !== undefined) {
      if (outputTokens === last.outputTokens) return;
      // A drop is the next assistant response's counter (providers report per
      // response), not negative speed; start a new window rather than average
      // across the reset.
      if (outputTokens < last.outputTokens) {
        window = [];
      } else if (observedAtMs < last.at) {
        return;
      }
    }
    window.push({ at: observedAtMs, outputTokens });
    if (window.length > 1) {
      const cutoff = window.at(-1)!.at - WINDOW_MS;
      let drop = 0;
      while (drop < window.length - 2 && window[drop]!.at < cutoff) drop += 1;
      if (drop > 0) window = window.slice(drop);
      if (window.length > MAX_SAMPLES) window = window.slice(window.length - MAX_SAMPLES);
    }
  };

  const tokensPerSecond = (nowMs: number): number | null => {
    const newest = window.at(-1);
    if (newest === undefined) return null;
    if (nowMs - newest.at > STALL_MS) return null;
    const oldest = window[0];
    if (oldest === undefined || window.length < 2) return null;
    if (newest.outputTokens <= oldest.outputTokens) return null;
    let activeMs = 0;
    for (let index = 1; index < window.length; index += 1) {
      const gap = window[index]!.at - window[index - 1]!.at;
      if (gap > 0 && gap <= MAX_GENERATE_GAP_MS) activeMs += gap;
    }
    if (activeMs <= 0) return null;
    return (newest.outputTokens - oldest.outputTokens) / (activeMs / 1_000);
  };

  return { push, tokensPerSecond, reset };
}

/**
 * Compact rate label (`"47 tok/s"`, `"8.2 tok/s"`). Integers above ten keep the
 * row from jittering wildly; a finer value only helps at low speeds, where a
 * single token is a large step.
 */
export function formatTokensPerSecond(tokensPerSecond: number): string {
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return "0 tok/s";
  const rounded =
    tokensPerSecond >= 10 ? Math.round(tokensPerSecond) : Math.round(tokensPerSecond * 10) / 10;
  return `${rounded} tok/s`;
}
