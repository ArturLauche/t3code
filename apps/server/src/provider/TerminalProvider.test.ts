import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { TERMINAL_DEFAULT_MODEL, type TerminalSettings } from "@t3tools/contracts";

import { buildInitialTerminalProviderSnapshot } from "./TerminalProvider.ts";

const decodeSettings = (input: Partial<TerminalSettings>): TerminalSettings =>
  ({ enabled: true, shell: "", command: "", customModels: [], ...input }) as TerminalSettings;

describe("TerminalProvider", () => {
  it.effect("marks the instance as a terminal with one opaque model", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialTerminalProviderSnapshot(decodeSettings({}));
      expect(snapshot.terminal).toBe(true);
      expect(snapshot.supportsTextGeneration).toBe(false);
      expect(snapshot.models).toHaveLength(1);
      expect(snapshot.models[0]?.slug).toBe(TERMINAL_DEFAULT_MODEL);
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
    }),
  );

  it.effect("reports disabled when the instance is disabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialTerminalProviderSnapshot(
        decodeSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
    }),
  );
});
