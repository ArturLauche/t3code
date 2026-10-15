import type { ScopedThreadRef } from "@t3tools/contracts";
import { Gauge as GaugeIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { readThreadOutputTokenUsage } from "~/state/entities";
import {
  createOutputTokenRateTracker,
  formatTokensPerSecond,
} from "@t3tools/shared/generationTiming";

import { ComposerBanner } from "./ComposerBanner";

/**
 * Live output tokens-per-second for the active turn, shown while the agent is
 * generating. Mirrors AgentElapsed: the registry is polled on a short timer and
 * the value is written straight to the text node, so streaming tokens cause no
 * React commits on the composer. The number freezes on its last value during a
 * tool call, and the whole row disappears once the turn is no longer running.
 */
export function ComposerStreamingTps({
  active,
  threadRef,
}: {
  /** True while the active turn is running; drives the poll lifecycle. */
  readonly active: boolean;
  readonly threadRef: ScopedThreadRef | null;
}) {
  const valueRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!active || threadRef === null) {
      if (valueRef.current) valueRef.current.textContent = "";
      return;
    }
    const tracker = createOutputTokenRateTracker();
    const tick = () => {
      const now = Date.now();
      const sample = readThreadOutputTokenUsage(threadRef);
      // The tracker ignores unchanged counts and counter resets, so each push
      // is the next generating sample: a fresh assistant response starts a new
      // window, and tool-call silence never enters the active-time denominator.
      if (sample !== null) tracker.push(now, sample.outputTokens);
      const tokensPerSecond = tracker.tokensPerSecond(now);
      // A null rate means "not generating right now"; keep the last value frozen
      // rather than blanking it, so the row never flickers between bursts.
      if (tokensPerSecond !== null && valueRef.current) {
        valueRef.current.textContent = formatTokensPerSecond(tokensPerSecond);
      }
    };
    tick();
    const interval = setInterval(tick, 250);
    return () => clearInterval(interval);
  }, [active, threadRef]);

  return (
    <ComposerBanner.Row data-composer-streaming-tps="true">
      <ComposerBanner.Icon>
        <GaugeIcon />
      </ComposerBanner.Icon>
      <ComposerBanner.Content>
        <span
          ref={valueRef}
          aria-hidden
          className="shrink-0 whitespace-nowrap tabular-nums text-muted-foreground"
        />
        {/* The number changes every tick and is aria-hidden above; announce the
            coarse state once when the row appears instead of the live rate. */}
        <span role="status" className="sr-only">
          Generating
        </span>
      </ComposerBanner.Content>
    </ComposerBanner.Row>
  );
}
