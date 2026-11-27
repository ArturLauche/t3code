import {
  TERMINAL_DEFAULT_MODEL,
  TERMINAL_DRIVER_KIND,
  type ModelCapabilities,
  type ServerProviderModel,
  type TerminalSettings,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  buildServerProvider,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";

export const TERMINAL_PROVIDER = TERMINAL_DRIVER_KIND;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

/**
 * A terminal thread has no model. The opaque alias keeps the thread's selection
 * routable through the same provider-instance machinery as every other thread.
 */
const TERMINAL_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: TERMINAL_DEFAULT_MODEL,
    name: "Terminal",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];

const TERMINAL_PRESENTATION = {
  displayName: "Terminal",
  badgeLabel: "Terminal",
  showInteractionModeToggle: false,
  supportsConversationRollback: false,
  supportsTextGeneration: false,
  requiresNewThreadForModelChange: true,
  // A terminal is a raw shell on the server; it enforces full access itself.
  supportedRuntimeModes: ["full-access"],
  terminal: true,
} as const;

/**
 * A terminal needs no installed CLI: the server's own shell is the runtime, so
 * the instance is always ready. `settings` only customizes which shell or
 * command the thread launches, which the terminal manager reads at open time.
 */
export function buildInitialTerminalProviderSnapshot(
  settings: TerminalSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.map(DateTime.now, DateTime.formatIso).pipe(
    Effect.map((checkedAt) =>
      buildServerProvider({
        presentation: TERMINAL_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: TERMINAL_MODELS,
        probe: settings.enabled
          ? {
              installed: true,
              version: null,
              status: "ready",
              auth: { status: "authenticated", label: "Server shell" },
              message: "Terminal threads run a persistent shell on this server.",
            }
          : {
              installed: false,
              version: null,
              status: "disabled",
              auth: { status: "unknown" },
              message: "Terminal is disabled in T3 Code settings.",
            },
      }),
    ),
  );
}
