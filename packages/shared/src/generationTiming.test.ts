import { describe, expect, it } from "vite-plus/test";

import { createOutputTokenRateTracker, formatTokensPerSecond } from "./generationTiming.ts";

describe("createOutputTokenRateTracker", () => {
  it("measures the slope of a steadily generating counter", () => {
    const tracker = createOutputTokenRateTracker();
    // +100 tokens every 200ms == 500 tok/s.
    for (let step = 0; step <= 8; step += 1) {
      tracker.push(step * 200, step * 100);
    }
    const now = 8 * 200;
    expect(tracker.tokensPerSecond(now)).toBeCloseTo(500, 5);
  });

  it("skips idle gaps so a tool call does not drag the rate down", () => {
    const tracker = createOutputTokenRateTracker();
    tracker.push(0, 0);
    tracker.push(200, 100);
    // Long tool-call gap, then the next response bursts at 100 tokens / 200ms.
    tracker.push(4_000, 150);
    tracker.push(4_200, 250);
    tracker.push(4_400, 350);
    // The inactive interval across the gap must not enter the denominator.
    expect(tracker.tokensPerSecond(4_400)).toBeCloseTo(500, 5);
  });

  it("starts a new window when the counter resets to a new response", () => {
    const tracker = createOutputTokenRateTracker();
    tracker.push(0, 500);
    tracker.push(200, 900);
    // Providers report per-response totals, so a later response restarts small.
    tracker.push(2_000, 20);
    tracker.push(2_200, 160);
    tracker.push(2_400, 300);
    expect(tracker.tokensPerSecond(2_400)).toBeCloseTo(700, 5);
  });

  it("goes quiet once no tokens arrive within the stall window", () => {
    const tracker = createOutputTokenRateTracker();
    tracker.push(0, 0);
    tracker.push(200, 100);
    expect(tracker.tokensPerSecond(600)).toBeCloseTo(500, 5);
    // Two seconds of silence is a pause, not steady generation.
    expect(tracker.tokensPerSecond(2_200)).toBeNull();
  });

  it("stays quiet until a rate is actually measurable", () => {
    const tracker = createOutputTokenRateTracker();
    expect(tracker.tokensPerSecond(0)).toBeNull();
    tracker.push(0, 100);
    expect(tracker.tokensPerSecond(0)).toBeNull();
  });

  it("ignores unchanged counters and regressing timestamps", () => {
    const tracker = createOutputTokenRateTracker();
    tracker.push(0, 0);
    tracker.push(200, 100);
    tracker.push(200, 100); // duplicate read of the same snapshot
    tracker.push(150, 120); // more tokens at an earlier time: drop the stale read
    tracker.push(400, 200);
    // window keeps {0,0},{200,100},{400,200} == 200 tokens over 400 active ms.
    expect(tracker.tokensPerSecond(400)).toBeCloseTo(500, 5);
  });

  it("drops all state on reset", () => {
    const tracker = createOutputTokenRateTracker();
    tracker.push(0, 0);
    tracker.push(200, 100);
    tracker.reset();
    expect(tracker.tokensPerSecond(400)).toBeNull();
  });
});

describe("formatTokensPerSecond", () => {
  it.each([
    [0, "0 tok/s"],
    [5.24, "5.2 tok/s"],
    [8.97, "9 tok/s"],
    [12.4, "12 tok/s"],
    [47.6, "48 tok/s"],
    [1e6, "1000000 tok/s"],
  ])("formats %d as %s", (tps, expected) => {
    expect(formatTokensPerSecond(tps)).toBe(expected);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("guards invalid input: %s", (tps) => {
    expect(formatTokensPerSecond(tps)).toBe("0 tok/s");
  });
});
