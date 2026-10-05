import {
  ClineSettings,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
  type ProviderApprovalOption,
  type ProviderInstanceId,
  type RuntimeMode,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as AcpCompat from "effect-acp/compat";

import type { CloudRemoteCwdResolver } from "../../cloud/runtime/CloudExecutionSpawner.ts";
import * as ServerConfig from "../../config.ts";
import { acpPermissionDisposition } from "../../provider/acp/AcpClientPolicy.ts";
import { makeAcpNativeLoggerFactory } from "../../provider/acp/AcpNativeLogging.ts";
import * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import {
  applyClineAcpModelSelection,
  CLINE_SUPPORTED_RUNTIME_MODES,
  clineSupportsRuntimeMode,
  makeClineAcpRuntime,
  resolveClineActModeId,
  type ClineAcpRuntimeClineSettings,
} from "../../provider/acp/ClineAcpSupport.ts";
import * as ProviderEventLoggers from "../../provider/Layers/ProviderEventLoggers.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ProviderAdapter from "../ProviderAdapter.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "../ProviderAdapterDriver.ts";
import * as ProviderContinuationRequests from "../ProviderContinuationRequests.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "./AcpAdapterV2.ts";

export const CLINE_PROVIDER = ProviderDriverKind.make("cline");
const CLINE_DRIVER_KIND = CLINE_PROVIDER;
const DEFAULT_CLINE_SETTINGS = Schema.decodeSync(ClineSettings)({});

/**
 * What Cline actually supports, rather than what ACP allows in general:
 *
 * - No conversation rollback. The CLI keeps no transcript T3 could truncate,
 *   so `canRollbackThread` is off and a checkpoint restores files only.
 * - The model travels as a session config option, so it is switchable in
 *   session even though `supportsRuntimeModeSwitchInSession` is not: approval
 *   is fixed by the launch-time `auto_approve` boolean.
 * - No MCP tools. `--acp` accepts `mcpServers` and never connects them, so the
 *   runtime instructions must not tell Cline to call them.
 */
const ClineProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    supportsRuntimeModeSwitchInSession: false,
  },
  threads: {
    ...AcpProviderCapabilitiesV2.threads,
    canRollbackThread: false,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: false,
  },
} satisfies OrchestrationV2ProviderCapabilities;

/** Cline's permission option ids are snake_case, unlike the ACP defaults. */
const CLINE_ALLOW_ONCE_OPTION_ID = "allow_once";
const CLINE_ALLOW_ALWAYS_OPTION_ID = "allow_always";
const CLINE_REJECT_ONCE_OPTION_ID = "reject_once";

function clineHasOption(
  request: AcpCompat.RequestPermissionRequest,
  kind: AcpCompat.PermissionOption["kind"],
  optionId: string,
): boolean {
  return request.options.some(
    (option) => option.kind === kind && option.optionId.trim() === optionId,
  );
}

/**
 * Cline offers only "allow once", "allow always" and "reject once". There is no
 * per-session grant, so "Always allow" is the widest decision the card can
 * record and every other T3 decision maps onto one of the three.
 */
function clineApprovalOptions(
  request: AcpCompat.RequestPermissionRequest,
): ReadonlyArray<ProviderApprovalOption> {
  return [
    { decision: "cancel", label: "Cancel" },
    ...(clineHasOption(request, "reject_once", CLINE_REJECT_ONCE_OPTION_ID)
      ? [{ decision: "decline", label: "Decline" } as const]
      : []),
    ...(clineHasOption(request, "allow_always", CLINE_ALLOW_ALWAYS_OPTION_ID)
      ? [{ decision: "acceptForSession", label: "Always allow" } as const]
      : []),
    ...(clineHasOption(request, "allow_once", CLINE_ALLOW_ONCE_OPTION_ID)
      ? [{ decision: "accept", label: "Approve" } as const]
      : []),
  ];
}

export interface ClineAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: ClineSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly crypto: Crypto.Crypto;
  readonly fileSystem: FileSystem.FileSystem;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly selfInvocation: SelfInvocation;
  readonly serverConfig: ServerConfig.ServerConfig["Service"];
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  /** Maps a local workspace path to its cloud-sandbox path, when remote. */
  readonly remoteCwdFor?: CloudRemoteCwdResolver | undefined;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  readonly makeRuntime?: AcpAdapterV2Flavor["makeRuntime"];
}

export function makeClineAcpAdapterFlavor(options: ClineAdapterV2Options): AcpAdapterV2Flavor {
  const clineSettings: ClineAcpRuntimeClineSettings = {
    binaryPath: options.settings.binaryPath,
    dataDir: options.settings.dataDir,
  };
  return {
    driver: CLINE_PROVIDER,
    runtimeHarness: "Cline",
    capabilities: ClineProviderCapabilitiesV2,
    // `--acp` receives `mcpServers` and never connects them.
    supportsMcpTooling: false,
    // Cline advertises `promptCapabilities.image: true` and then drops every
    // non-text block before dispatch, so a prompt never carries one.
    supportsImagePrompts: false,
    approvalOptions: clineApprovalOptions,
    // Act is the only mode T3 drives; Plan is a CLI mode the picker never offers.
    sessionModeForPolicy: () => "act",
    permissionDisposition: (policy, request) =>
      policy.runtimeMode === "full-access"
        ? // Full access is T3 approving on the user's behalf. Cline's own
          // `auto_approve` is fixed at launch, so the grant lives here.
          "allow"
        : clineSupportsRuntimeMode(policy.runtimeMode)
          ? acpPermissionDisposition(policy, request)
          : "deny",
    promptFailure: (cause) =>
      makeProviderFailure({
        cause,
        message: Schema.is(EffectAcpErrors.AcpRequestError)(cause) ? cause.errorMessage : undefined,
        class: "provider_error",
      }),
    resolveModelId: (selection) => selection.model,
    applyModelSelection: ({ runtime, modelSelection }) =>
      Effect.gen(function* () {
        // Cline can be left in Plan mode by the user switching inside its own
        // TUI, so re-select Act on every session setup and every turn's
        // reconfiguration. `resolveClineActModeId` returns the advertised id.
        const actModeId = resolveClineActModeId(yield* runtime.getModeState);
        if (actModeId !== undefined) {
          yield* runtime.setMode(actModeId).pipe(Effect.ignore);
        }
        yield* applyClineAcpModelSelection({
          runtime,
          requestedModelId: modelSelection.model,
          mapError: (cause) => cause,
        });
        return modelSelection.model;
      }).pipe(
        Effect.mapError(
          (cause): EffectAcpErrors.AcpError =>
            new EffectAcpErrors.AcpTransportError({
              // A model Cline never advertised is a refusal, not a crash: the
              // CLI would otherwise accept any slug and pin the session to it.
              detail: cause.message,
              cause,
            }),
        ),
      ),
    makeRuntime:
      options.makeRuntime ??
      ((input: AcpAdapterV2RuntimeInput) => {
        const protocolCwd = options.remoteCwdFor?.(input.cwd);
        return makeClineAcpRuntime({
          ...input,
          // A sandboxed Cline only knows its own filesystem, so every cwd that
          // travels in a session message has to be the remote one.
          ...(protocolCwd === undefined ? {} : { protocolCwd }),
          clineSettings,
          environment: options.environment,
          childProcessSpawner: options.childProcessSpawner,
        });
      }),
  };
}

export function makeClineAdapterV2(
  options: ClineAdapterV2Options,
): ProviderAdapter.ProviderAdapterV2Shape {
  return makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeClineAcpAdapterFlavor(options),
    crypto: options.crypto,
    fileSystem: options.fileSystem,
    idAllocator: options.idAllocator,
    serverConfig: options.serverConfig,
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
  });
}

export type ClineAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig;

export const ClineAdapterV2Driver: ProviderAdapterDriver<ClineSettings, ClineAdapterV2DriverEnv> = {
  driverKind: CLINE_DRIVER_KIND,
  configSchema: ClineSettings,
  defaultConfig: (): ClineSettings => DEFAULT_CLINE_SETTINGS,
  create: Effect.fn("ClineAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<ClineSettings>) {
      const hostEnvironment = yield* HostProcessEnvironment;
      const localChildProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const selfInvocation = yield* resolveSelfInvocation();
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return makeClineAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        crypto,
        fileSystem,
        idAllocator,
        selfInvocation,
        serverConfig,
        childProcessSpawner: input.cloudTransport?.spawner ?? localChildProcessSpawner,
        ...(input.cloudTransport ? { remoteCwdFor: input.cloudTransport.remoteCwdFor } : {}),
        continuationRequests,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: CLINE_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: CLINE_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create the Cline ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};

export { CLINE_SUPPORTED_RUNTIME_MODES };
