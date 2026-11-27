// @effect-diagnostics effectFnOpportunity:off -- Fork-only adapter predates the Effect.fn lint rule.
import {
  TERMINAL_DRIVER_KIND,
  type OrchestrationV2ProviderCapabilities,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

/**
 * A terminal thread's session is the PTY the terminal manager owns, not a model
 * turn runtime. The adapter therefore declares the terminal capability and
 * refuses to open a model session: clients drive the terminal directly and never
 * dispatch a turn to a terminal thread.
 */
const TerminalProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
    terminal: true,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: false,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: false,
    emitsTurnCompleted: false,
    supportsInterrupt: false,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: false,
    terminalStatusQuality: "none",
  },
  streaming: {
    streamsAssistantText: false,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: false,
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
    appCanCheckpointFilesystem: false,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "none",
    nativeTurnIds: "none",
    nativeItemIds: "none",
    nativeRequestIds: "none",
  },
} satisfies OrchestrationV2ProviderCapabilities;

const TERMINAL_SESSION_MESSAGE =
  "Terminal threads run a persistent shell, not a model turn. Use the thread's terminal instead of sending a message.";

interface TerminalAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
}

export function makeTerminalAdapterV2(
  options: TerminalAdapterV2Options,
): ProviderAdapter.ProviderAdapterV2["Service"] {
  const openSession = Effect.fail(
    new ProviderAdapter.ProviderAdapterOpenSessionError({
      driver: TERMINAL_DRIVER_KIND,
      providerSessionId: "terminal" as never,
      cause: new Error(TERMINAL_SESSION_MESSAGE),
    }),
  );

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: TERMINAL_DRIVER_KIND,
    getCapabilities: () => Effect.succeed(TerminalProviderCapabilitiesV2),
    // A terminal has no model to switch, so a selection can only be recorded.
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => openSession,
  });
}
