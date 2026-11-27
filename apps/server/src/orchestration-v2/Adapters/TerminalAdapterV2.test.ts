import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  TERMINAL_DEFAULT_MODEL,
  TERMINAL_DRIVER_KIND,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { ProviderAdapterOpenSessionError } from "@t3tools/provider-core/server/ProviderAdapter";

import { makeTerminalAdapterV2 } from "./TerminalAdapterV2.ts";

const INSTANCE_ID = "terminal" as ProviderInstanceId;

describe("TerminalAdapterV2", () => {
  it.effect("declares the terminal capability and no turn capabilities", () =>
    Effect.gen(function* () {
      const adapter = makeTerminalAdapterV2({ instanceId: INSTANCE_ID });
      const capabilities = yield* adapter.getCapabilities();
      expect(capabilities.sessions.terminal).toBe(true);
      expect(capabilities.turns.emitsTurnStarted).toBe(false);
      expect(capabilities.threads.canCreateEmptyThread).toBe(true);
      expect(adapter.driver).toBe(TERMINAL_DRIVER_KIND);
    }),
  );

  it.effect("refuses to open a model session", () =>
    Effect.gen(function* () {
      const adapter = makeTerminalAdapterV2({ instanceId: INSTANCE_ID });
      const error = yield* adapter
        .openSession({
          threadId: "thread" as never,
          providerSessionId: "session" as never,
          modelSelection: { instanceId: INSTANCE_ID, model: TERMINAL_DEFAULT_MODEL, options: [] },
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
        })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(ProviderAdapterOpenSessionError);
      expect(error.message).toContain("Failed to open terminal provider session");
    }),
  );
});
