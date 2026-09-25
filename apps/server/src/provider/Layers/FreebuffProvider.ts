import {
  FREEBUFF_DEFAULT_MODEL,
  type FreebuffSettings,
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess } from "effect/unstable/process";

import { expandHomePath } from "../../pathExpansion.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

export const FREEBUFF_PROVIDER = ProviderDriverKind.make("freebuff");

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const FREEBUFF_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: FREEBUFF_DEFAULT_MODEL,
    name: "Freebuff Auto",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];

const FREEBUFF_PRESENTATION = {
  displayName: "Freebuff",
  badgeLabel: "Experimental",
  showInteractionModeToggle: false,
  supportsConversationRollback: false,
  requiresNewThreadForModelChange: true,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 15_000;

const probeFreebuffVersion = (
  settings: FreebuffSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) =>
  Effect.gen(function* () {
    const binaryPath = expandHomePath(settings.binaryPath || "freebuff");
    const command = yield* resolveSpawnCommand(binaryPath, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      binaryPath,
      ChildProcess.make(command.command, command.args, {
        cwd,
        env: environment,
        shell: command.shell,
      }),
    );
  });

export function buildInitialFreebuffProviderSnapshot(
  settings: FreebuffSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.map(DateTime.now, DateTime.formatIso).pipe(
    Effect.map((checkedAt) =>
      buildServerProvider({
        presentation: FREEBUFF_PRESENTATION,
        enabled: settings.enabled,
        checkedAt,
        models: FREEBUFF_MODELS,
        probe: settings.enabled
          ? {
              installed: true,
              version: null,
              status: "warning",
              auth: { status: "unknown" },
              message: "Checking the Freebuff CLI...",
            }
          : {
              installed: false,
              version: null,
              status: "warning",
              auth: { status: "unknown" },
              message: "Freebuff is disabled in T3 Code settings.",
            },
      }),
    ),
    Effect.map((snapshot) => ({ ...snapshot, supportsTextGeneration: false })),
  );
}

export const checkFreebuffProviderStatus = Effect.fn("checkFreebuffProviderStatus")(function* (
  settings: FreebuffSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  isAuthenticated: boolean,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return {
      ...buildServerProvider({
        presentation: FREEBUFF_PRESENTATION,
        enabled: false,
        checkedAt,
        models: FREEBUFF_MODELS,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Freebuff is disabled in T3 Code settings.",
        },
      }),
      supportsTextGeneration: false,
    };
  }

  const result = yield* probeFreebuffVersion(settings, environment, cwd).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(result)) {
    const cause = result.failure;
    return {
      ...buildServerProvider({
        presentation: FREEBUFF_PRESENTATION,
        enabled: true,
        checkedAt,
        models: FREEBUFF_MODELS,
        probe: {
          installed: !isCommandMissingCause(cause),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(cause)
            ? "Freebuff CLI (`freebuff`) is not installed or not on PATH."
            : "Failed to execute the Freebuff CLI health check.",
        },
      }),
      supportsTextGeneration: false,
    };
  }

  if (Option.isNone(result.success)) {
    return {
      ...buildServerProvider({
        presentation: FREEBUFF_PRESENTATION,
        enabled: true,
        checkedAt,
        models: FREEBUFF_MODELS,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Freebuff is installed, but `freebuff --version` timed out.",
        },
      }),
      supportsTextGeneration: false,
    };
  }

  const output = result.success.value;
  const version = parseGenericCliVersion(`${output.stdout}\n${output.stderr}`);
  const healthy = output.code === 0;
  return {
    ...buildServerProvider({
      presentation: FREEBUFF_PRESENTATION,
      enabled: true,
      checkedAt,
      models: FREEBUFF_MODELS,
      probe: healthy
        ? isAuthenticated
          ? {
              installed: true,
              version,
              status: "ready",
              auth: { status: "authenticated", label: "Freebuff account" },
              message:
                "Freebuff is installed and signed in. T3 Code uses the model selected by Freebuff when a thread starts.",
            }
          : {
              installed: true,
              version,
              status: "error",
              auth: { status: "unauthenticated" },
              message:
                "Freebuff is installed, but this provider instance is not signed in. Open a terminal with this provider instance and run `freebuff login`, then retry.",
            }
        : {
            installed: true,
            version,
            status: "error",
            auth: { status: "unknown" },
            message: "Freebuff is installed, but `freebuff --version` failed.",
          },
    }),
    supportsTextGeneration: false,
  };
});
