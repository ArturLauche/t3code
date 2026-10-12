import { FreebuffSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { makeFreebuffAdapterV2 } from "../../orchestration-v2/Adapters/FreebuffAdapterV2.ts";
import { makeUnsupportedTextGeneration } from "../../textGeneration/unsupportedTextGeneration.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  buildInitialFreebuffProviderSnapshot,
  checkFreebuffProviderStatus,
  FREEBUFF_PROVIDER,
} from "../FreebuffProvider.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { ensureFreebuffConfigDir, resolveFreebuffConfigDir } from "./FreebuffConfig.ts";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";

const decodeFreebuffSettings = Schema.decodeSync(FreebuffSettings);
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: FREEBUFF_PROVIDER,
  packageName: null,
});

export const freebuffCredentialsHaveToken = (raw: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const profile = (parsed as Record<string, unknown>).default;
    if (typeof profile !== "object" || profile === null || Array.isArray(profile)) return false;
    const authToken = (profile as Record<string, unknown>).authToken;
    return typeof authToken === "string" && authToken.trim().length > 0;
  } catch {
    return false;
  }
};

export type FreebuffDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | ServerConfig
  | ProviderHost.ProviderHost;

export const FreebuffDriver: ProviderDriver<FreebuffSettings, FreebuffDriverEnv> = {
  driverKind: FREEBUFF_PROVIDER,
  metadata: {
    displayName: "Freebuff",
    supportsMultipleInstances: false,
    supportsCloudExecution: false,
  },
  configSchema: FreebuffSettings,
  defaultConfig: (): FreebuffSettings => decodeFreebuffSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverConfig = yield* ServerConfig;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const effectiveConfig = {
        ...config,
        enabled,
        binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
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
        ...(yield* mergeProviderInstanceEnvironment(environment)),
        FREEBUFF_CONFIG_DIR: configDir,
      };
      const readIsAuthenticated = Effect.gen(function* () {
        const hasCredentialsFile = yield* fileSystem
          .readFileString(path.join(configDir, "credentials.json"))
          .pipe(
            Effect.map(freebuffCredentialsHaveToken),
            Effect.orElseSucceed(() => false),
          );
        return hasCredentialsFile || Boolean(processEnvironment.CODEBUFF_API_KEY?.trim());
      });
      // The server provides the live PTY service at the runtime boundary;
      // Freebuff intentionally has no cloud PTY transport.
      const orchestrationAdapter = makeFreebuffAdapterV2({
        instanceId,
        settings: effectiveConfig,
        configDir,
        environment: processEnvironment,
        idAllocator,
        serverConfig,
      });
      const checkProvider = Effect.gen(function* () {
        const isAuthenticated = yield* readIsAuthenticated;
        return yield* checkFreebuffProviderStatus(
          effectiveConfig,
          processEnvironment,
          serverConfig.cwd,
          isAuthenticated,
        );
      }).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      );
      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
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
        orchestrationAdapter,
        textGeneration: makeUnsupportedTextGeneration(FREEBUFF_PROVIDER),
      } satisfies ProviderInstance;
    }),
};
