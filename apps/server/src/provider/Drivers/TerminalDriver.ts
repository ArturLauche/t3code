// @effect-diagnostics effectFnOpportunity:off -- Fork-only adapter predates the Effect.fn lint rule.
import { TerminalSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { makeUnsupportedTextGeneration } from "../../textGeneration/unsupportedTextGeneration.ts";
import { makeTerminalAdapterV2 } from "../../orchestration-v2/Adapters/TerminalAdapterV2.ts";
import { buildInitialTerminalProviderSnapshot, TERMINAL_PROVIDER } from "../TerminalProvider.ts";

const decodeTerminalSettings = Schema.decodeSync(TerminalSettings);
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: TERMINAL_PROVIDER,
  packageName: null,
});

export type TerminalDriverEnv = ProviderHost.ProviderHost;

export const TerminalDriver: ProviderDriver<TerminalSettings, TerminalDriverEnv> = {
  driverKind: TERMINAL_PROVIDER,
  metadata: {
    displayName: "Terminal",
    // One terminal instance per server: the shell is a shared host resource.
    supportsMultipleInstances: false,
    supportsCloudExecution: false,
    hasDefaultInstance: true,
  },
  configSchema: TerminalSettings,
  defaultConfig: (): TerminalSettings => decodeTerminalSettings({}),
  create: Effect.fn("TerminalDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    enabled,
    config,
  }) {
    const effectiveConfig = { ...config, enabled } satisfies TerminalSettings;
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: TERMINAL_PROVIDER,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: TERMINAL_PROVIDER,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const orchestrationAdapter = makeTerminalAdapterV2({ instanceId });
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<TerminalSettings>>({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialTerminalProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider: buildInitialTerminalProviderSnapshot(effectiveConfig).pipe(
        Effect.map(stampIdentity),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: TERMINAL_PROVIDER,
            instanceId,
            detail: `Failed to build Terminal snapshot: ${cause.message ?? String(cause)}`,
            cause,
          }),
      ),
    );

    return {
      instanceId,
      driverKind: TERMINAL_PROVIDER,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      orchestrationAdapter,
      textGeneration: makeUnsupportedTextGeneration(TERMINAL_PROVIDER),
    } satisfies ProviderInstance;
  }),
};
