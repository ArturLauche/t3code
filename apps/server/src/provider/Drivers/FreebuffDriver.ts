import { FreebuffSettings } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { CloudRuntimeService } from "../../cloud/runtime/CloudRuntimeService.ts";
import {
  makeCloudExecutionSpawner,
  makeCloudPtyAdapter,
} from "../../cloud/runtime/CloudExecutionSpawner.ts";
import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeFreebuffAdapter } from "../Layers/FreebuffAdapter.ts";
import {
  buildInitialFreebuffProviderSnapshot,
  checkFreebuffProviderStatus,
  FREEBUFF_PROVIDER,
} from "../Layers/FreebuffProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { ensureFreebuffConfigDir, resolveFreebuffConfigDir } from "./FreebuffConfig.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const decodeFreebuffSettings = Schema.decodeSync(FreebuffSettings);
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: FREEBUFF_PROVIDER,
  packageName: null,
});

type UnsupportedTextGenerationOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const unsupportedTextGeneration = (operation: UnsupportedTextGenerationOperation) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail:
        "Freebuff does not expose a machine-readable text-generation API; use a Freebuff agent thread instead.",
    }),
  );

const textGeneration = {
  generateCommitMessage: () => unsupportedTextGeneration("generateCommitMessage"),
  generatePrContent: () => unsupportedTextGeneration("generatePrContent"),
  generateBranchName: () => unsupportedTextGeneration("generateBranchName"),
  generateThreadTitle: () => unsupportedTextGeneration("generateThreadTitle"),
} satisfies TextGeneration.TextGeneration["Service"];

export type FreebuffDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig
  | ServerSettingsService;

export const FreebuffDriver: ProviderDriver<FreebuffSettings, FreebuffDriverEnv> = {
  driverKind: FREEBUFF_PROVIDER,
  metadata: {
    displayName: "Freebuff",
    supportsMultipleInstances: true,
    supportsCloudExecution: true,
  },
  configSchema: FreebuffSettings,
  defaultConfig: (): FreebuffSettings => decodeFreebuffSettings({}),
  create: ({
    instanceId,
    displayName,
    accentColor,
    environment,
    executionTarget,
    enabled,
    config,
  }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const cloudRuntime = yield* CloudRuntimeService;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const effectiveConfig = {
        ...config,
        enabled,
        binaryPath: expandHomePath(config.binaryPath),
      } satisfies FreebuffSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: FREEBUFF_PROVIDER,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: FREEBUFF_PROVIDER,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const configDir = yield* resolveFreebuffConfigDir({
        settings: effectiveConfig,
        instanceId,
        stateDir: serverConfig.stateDir,
      }).pipe(
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: FREEBUFF_PROVIDER,
              instanceId,
              detail: "Failed to resolve the Freebuff configuration directory.",
              cause,
            }),
        ),
      );
      if (effectiveConfig.enabled) {
        yield* ensureFreebuffConfigDir(configDir).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: FREEBUFF_PROVIDER,
                instanceId,
                detail: "Failed to create the Freebuff configuration directory.",
                cause,
              }),
          ),
        );
      }
      const processEnvironment: NodeJS.ProcessEnv = {
        ...mergeProviderInstanceEnvironment(environment),
        FREEBUFF_CONFIG_DIR: configDir,
      };
      const cloudTransport =
        executionTarget?.enabled === true
          ? yield* makeCloudExecutionSpawner({
              cloud: cloudRuntime,
              localSpawner: childProcessSpawner,
              runtimeId: executionTarget.runtimeId,
              instanceId,
              environment: processEnvironment,
              providerEnvironment: environment,
              sandboxPrefix: `t3-freebuff-${instanceId}`,
            })
          : undefined;
      const adapter = yield* makeFreebuffAdapter({
        settings: effectiveConfig,
        configDir,
        environment: processEnvironment,
        instanceId,
        defaultCwd: serverConfig.cwd,
        ...(cloudTransport ? { ptyAdapter: makeCloudPtyAdapter(cloudTransport.spawnNode) } : {}),
      });
      const checkProvider = checkFreebuffProviderStatus(
        effectiveConfig,
        processEnvironment,
        serverConfig.cwd,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<FreebuffSettings>>(
        {
          resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
          getSettings: snapshotSettings.getSettings,
          streamSettings: snapshotSettings.streamSettings,
          haveSettingsChanged: haveProviderSnapshotSettingsChanged,
          initialSnapshot: (settings) =>
            buildInitialFreebuffProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
          checkProvider,
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: FREEBUFF_PROVIDER,
              instanceId,
              detail: `Failed to build Freebuff snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: FREEBUFF_PROVIDER,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
