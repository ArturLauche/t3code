/**
 * ClineDriver — `ProviderDriver` for the Cline CLI runtime.
 *
 * Cline is driven entirely over ACP (`cline --acp`). The managed provider status
 * check is the discovery path: it runs `cline --version` for installation state
 * and one throwaway ACP session for authentication and the model catalog, because
 * Cline has no non-interactive auth-status command.
 *
 * Background text generation is intentionally absent. Cline's ACP build
 * hard-disables reasoning, boots an interactive session on the user's account,
 * and would need a full agent turn to produce a title or a commit message. The
 * snapshot advertises `supportsTextGeneration: false` so T3 Code routes those
 * to a provider that can serve them cheaply.
 *
 * @module provider/Drivers/ClineDriver
 */
import { ClineSettings, ProviderDriverKind } from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import {
  ClineAdapterV2Driver,
  type ClineAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/ClineAdapterV2.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { makeUnsupportedTextGeneration } from "../../textGeneration/unsupportedTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  buildInitialClineProviderSnapshot,
  checkClineProviderStatus,
} from "../Layers/ClineProvider.ts";
import * as ProviderEventLoggers from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const decodeClineSettings = Schema.decodeSync(ClineSettings);

const DRIVER_KIND = ProviderDriverKind.make("cline");
// `cline update` self-installs the global package, so a resolved executable is
// also the thing to run an update against.
const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "cline",
  nativeUpdate: null,
});

export type ClineDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | ClineAdapterV2DriverEnv
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService;

export const ClineDriver: ProviderDriver<ClineSettings, ClineDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Cline",
    supportsMultipleInstances: true,
  },
  configSchema: ClineSettings,
  defaultConfig: (): ClineSettings => decodeClineSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const httpClient = yield* HttpClient.HttpClient;
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies ClineSettings;
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ClineSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialClineProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider: checkClineProviderStatus(effectiveConfig, processEnv).pipe(
          Effect.map(stampIdentity),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichProviderSnapshotWithVersionAdvisory(currentSnapshot, maintenanceCapabilities, {
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              }),
            ),
            Effect.flatMap((enriched) => publishSnapshot(enriched)),
            Effect.catchCause((cause) =>
              Effect.logWarning("Cline version advisory enrichment failed", {
                errorTag: causeErrorTag(cause),
              }),
            ),
            Effect.asVoid,
            Effect.provideService(HttpClient.HttpClient, httpClient),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build the Cline provider snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      const orchestrationAdapter = yield* ClineAdapterV2Driver.create({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build the Cline orchestration adapter.",
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter,
        // Declared unsupported through the snapshot's `supportsTextGeneration`,
        // so this only answers if a caller reaches for it anyway.
        textGeneration: makeUnsupportedTextGeneration(DRIVER_KIND),
      } satisfies ProviderInstance;
    }),
};
