import * as NodeCrypto from "node:crypto";

import {
  CloudRuntimeError,
  CloudRuntimeId,
  type CloudExecutionHandle,
  cloudRuntimeErrorMessage,
  type CloudRuntimeConfig,
  type CloudRuntimeCredentialInput,
  type CloudRuntimeExecuteInput,
  type CloudRuntimeExecuteResult,
  type CloudRuntimeHealth,
  type CloudRuntimeInstance,
  type CloudRuntimeListResult,
  type CloudRuntimeSandboxActionInput,
  type CloudRuntimeSandboxCreateInput,
  type CloudRuntimeSandboxListInput,
  type CloudRuntimeSandboxListResult,
  type CloudRuntimeTestInput,
  type CloudSandboxSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { cloudRuntimeCredentialName } from "./credentialName.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { CloudRuntimeService, type CloudRuntimeServiceShape } from "./CloudRuntimeService.ts";
import {
  makeCloudVendorAdapter,
  type CloudCommandSpec,
  type CloudVendorAdapter,
} from "./VendorAdapter.ts";

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const credentialName = cloudRuntimeCredentialName;

const settingsError = (
  runtimeId: CloudRuntimeId | undefined,
  operation: string,
  message: string,
): CloudRuntimeError =>
  new CloudRuntimeError({
    ...(runtimeId ? { runtimeId } : {}),
    operation,
    reason: "operation_failed",
    message,
  });

const readStatusCode = (cause: unknown): number | undefined => {
  if (!Predicate.isObject(cause)) return undefined;
  for (const key of ["statusCode", "status"]) {
    const value = cause[key];
    if (Predicate.isNumber(value)) return value;
  }
  return undefined;
};

const readErrorName = (cause: unknown): string => {
  if (cause instanceof Error) return cause.name;
  if (Predicate.isObject(cause) && Predicate.isString(cause.name)) return cause.name;
  return "";
};

const redactSecrets = (message: string, secrets: ReadonlyArray<string>): string => {
  let redacted = message;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted;
};

const publicSandboxMetadata = (
  metadata: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined => {
  if (!metadata) return undefined;
  const allowed = [
    "name",
    "t3ManagedExecution",
    "t3RuntimeId",
    "t3EnvironmentId",
    "t3ProviderInstanceId",
  ] as const;
  const entries = allowed.flatMap((key) => {
    const value = metadata[key];
    return value === undefined ? [] : [[key, value] as const];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const safeCreateMetadata = (
  metadata: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined => {
  if (!metadata) return undefined;
  const providerInstanceId = metadata.t3ProviderInstanceId;
  return providerInstanceId ? { t3ProviderInstanceId: providerInstanceId } : undefined;
};

const mapVendorError = (input: {
  readonly runtimeId: CloudRuntimeId;
  readonly operation: string;
  readonly cause: unknown;
  readonly secrets: ReadonlyArray<string>;
}): CloudRuntimeError => {
  const status = readStatusCode(input.cause);
  const name = readErrorName(input.cause).toLowerCase();
  const message = redactSecrets(cloudRuntimeErrorMessage(input.cause), input.secrets);
  let reason: CloudRuntimeError["reason"] = "operation_failed";
  if (
    status === 401 ||
    status === 403 ||
    name.includes("authentication") ||
    name.includes("authorization")
  ) {
    reason = "invalid_credential";
  } else if (status === 404 || name.includes("notfound")) {
    reason = "sandbox_not_found";
  }
  return new CloudRuntimeError({
    runtimeId: input.runtimeId,
    operation: input.operation,
    reason,
    message,
  });
};

export interface CloudRuntimeServiceLiveOptions {
  readonly makeVendor?: typeof makeCloudVendorAdapter;
}

export const makeCloudRuntimeService = Effect.fnUntraced(function* (
  options?: CloudRuntimeServiceLiveOptions,
) {
  const serverSettings = yield* ServerSettingsService;
  const secretStore = yield* ServerSecretStore;
  const environmentIdentity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* environmentIdentity.getEnvironmentId;
  const makeVendor = options?.makeVendor ?? makeCloudVendorAdapter;
  const withSettingsWriteLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    serverSettings.withWriteLock ? serverSettings.withWriteLock(effect) : effect;

  const getSettings = (runtimeId?: CloudRuntimeId) =>
    serverSettings.getSettings.pipe(
      Effect.mapError((_cause) =>
        settingsError(runtimeId, "read-settings", "Failed to read cloud runtime settings."),
      ),
    );

  const readCredential = (runtimeId: CloudRuntimeId) =>
    secretStore.get(credentialName(runtimeId)).pipe(
      Effect.map((value) =>
        Option.match(value, {
          onNone: () => "",
          onSome: (bytes) => decoder.decode(bytes),
        }),
      ),
      Effect.mapError((_cause) =>
        settingsError(runtimeId, "read-credential", "Failed to read the cloud credential."),
      ),
    );

  const requireConfig = Effect.fnUntraced(function* (runtimeId: CloudRuntimeId) {
    const settings = yield* getSettings(runtimeId);
    const config = settings.cloudRuntimeInstances[runtimeId];
    if (!config) {
      return yield* new CloudRuntimeError({
        runtimeId,
        operation: "resolve-runtime",
        reason: "runtime_not_configured",
        message: "The cloud runtime is not configured.",
      });
    }
    if (!config.enabled) {
      return yield* new CloudRuntimeError({
        runtimeId,
        operation: "resolve-runtime",
        reason: "runtime_disabled",
        message: "The cloud runtime is disabled.",
      });
    }
    return { config, apiKey: yield* readCredential(runtimeId) };
  });

  const makeVendorFor = Effect.fnUntraced(function* (runtimeId: CloudRuntimeId) {
    const { config, apiKey } = yield* requireConfig(runtimeId);
    if (!apiKey) {
      return yield* new CloudRuntimeError({
        runtimeId,
        operation: "authenticate",
        reason: "credential_missing",
        message: "Add an API key for this cloud runtime.",
      });
    }
    const vendor = yield* Effect.try({
      try: () => makeVendor({ runtimeId, config, apiKey, environmentId }),
      catch: (cause) =>
        mapVendorError({ runtimeId, operation: "create-client", cause, secrets: [apiKey] }),
    });
    return { vendor, apiKey };
  });

  const closeVendor = (vendor: CloudVendorAdapter): Effect.Effect<void> =>
    vendor.close
      ? Effect.tryPromise({ try: () => vendor.close!(), catch: () => undefined }).pipe(
          Effect.orElseSucceed(() => undefined),
        )
      : Effect.void;

  const useVendor = <A, E, R>(
    runtimeId: CloudRuntimeId,
    use: (
      vendor: CloudVendorAdapter,
      context: { readonly apiKey: string },
    ) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | CloudRuntimeError, R> =>
    Effect.scoped(
      Effect.acquireRelease(makeVendorFor(runtimeId), ({ vendor }) => closeVendor(vendor)).pipe(
        Effect.flatMap(({ vendor, apiKey }) => use(vendor, { apiKey })),
      ),
    );

  const cleanupPreparedSandbox = (runtimeId: CloudRuntimeId, sandboxId: string) =>
    useVendor(runtimeId, (vendor, { apiKey }) =>
      Effect.tryPromise({
        try: () => vendor.action(sandboxId, "delete"),
        catch: (cause) =>
          mapVendorError({ runtimeId, operation: "cleanup-sandbox", cause, secrets: [apiKey] }),
      }).pipe(Effect.asVoid),
    ).pipe(Effect.catchCause(() => Effect.void));

  const isManagedSandbox = (sandbox: CloudSandboxSummary, runtimeId: CloudRuntimeId): boolean =>
    sandbox.metadata?.t3ManagedExecution === "true" &&
    sandbox.metadata?.t3RuntimeId === runtimeId &&
    sandbox.metadata?.t3EnvironmentId === environmentId;

  const stampSandboxes = (
    runtimeId: CloudRuntimeId,
    sandboxes: ReadonlyArray<CloudSandboxSummary>,
  ): ReadonlyArray<CloudSandboxSummary> =>
    sandboxes
      .filter((sandbox) => isManagedSandbox(sandbox, runtimeId))
      .map((sandbox) => {
        const { metadata: _metadata, ...withoutMetadata } = sandbox;
        const metadata = publicSandboxMetadata(sandbox.metadata);
        return {
          ...withoutMetadata,
          runtimeId,
          ...(metadata ? { metadata } : {}),
        };
      });

  const listOne = Effect.fnUntraced(function* (
    runtimeId: CloudRuntimeId,
    config: CloudRuntimeConfig,
  ) {
    const checkedAt = yield* nowIso;
    if (!config.enabled) {
      return {
        id: runtimeId,
        config,
        hasCredential: (yield* readCredential(runtimeId)) !== "",
        health: {
          status: "disabled",
          message: "Cloud runtime is disabled.",
          checkedAt,
        } satisfies CloudRuntimeHealth,
        sandboxes: [],
      } satisfies CloudRuntimeInstance;
    }
    const apiKey = yield* readCredential(runtimeId);
    if (!apiKey) {
      return {
        id: runtimeId,
        config,
        hasCredential: false,
        health: {
          status: "unconfigured",
          message: "Add an API key to test this cloud runtime.",
          checkedAt,
        } satisfies CloudRuntimeHealth,
        sandboxes: [],
      } satisfies CloudRuntimeInstance;
    }
    return yield* Effect.tryPromise({
      try: async () => {
        const vendor = makeVendor({ runtimeId, config, apiKey, environmentId });
        try {
          const sandboxes = await vendor.listSandboxes();
          return {
            id: runtimeId,
            config,
            hasCredential: true,
            health: {
              status: "ready",
              message: null,
              checkedAt,
            } satisfies CloudRuntimeHealth,
            sandboxes: stampSandboxes(runtimeId, sandboxes),
          } satisfies CloudRuntimeInstance;
        } finally {
          await vendor.close?.();
        }
      },
      catch: (cause) => mapVendorError({ runtimeId, operation: "list", cause, secrets: [apiKey] }),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          id: runtimeId,
          config,
          hasCredential: true,
          health: {
            status: "error",
            message: error.message,
            checkedAt,
          } satisfies CloudRuntimeHealth,
          sandboxes: [],
        } satisfies CloudRuntimeInstance),
      ),
    );
  });

  const list = Effect.fn("CloudRuntimeService.list")(function* () {
    const settings = yield* getSettings();
    return {
      runtimes: yield* Effect.forEach(
        Object.entries(settings.cloudRuntimeInstances),
        ([runtimeId, config]) => listOne(CloudRuntimeId.make(runtimeId), config),
        { concurrency: 4 },
      ),
    } satisfies CloudRuntimeListResult;
  });

  const setCredential = Effect.fn("CloudRuntimeService.setCredential")(function* (
    input: CloudRuntimeCredentialInput,
  ) {
    yield* withSettingsWriteLock(
      Effect.gen(function* () {
        const settings = yield* getSettings(input.runtimeId);
        if (!settings.cloudRuntimeInstances[input.runtimeId]) {
          return yield* new CloudRuntimeError({
            runtimeId: input.runtimeId,
            operation: "set-credential",
            reason: "runtime_not_configured",
            message: "The cloud runtime is not configured.",
          });
        }
        yield* secretStore
          .set(credentialName(input.runtimeId), encoder.encode(input.apiKey))
          .pipe(
            Effect.mapError((_cause) =>
              settingsError(
                input.runtimeId,
                "set-credential",
                "Failed to store the cloud credential.",
              ),
            ),
          );
      }),
    );
    return yield* list();
  });

  const clearCredential = Effect.fn("CloudRuntimeService.clearCredential")(function* (
    runtimeId: CloudRuntimeId,
  ) {
    yield* withSettingsWriteLock(
      Effect.gen(function* () {
        // Clearing is intentionally idempotent. Settings deletion and secret
        // cleanup can arrive in either order when a client removes a runtime.
        yield* secretStore
          .remove(credentialName(runtimeId))
          .pipe(
            Effect.mapError((_cause) =>
              settingsError(
                runtimeId,
                "clear-credential",
                "Failed to remove the cloud credential.",
              ),
            ),
          );
      }),
    );
    return yield* list();
  });

  const test = Effect.fn("CloudRuntimeService.test")(function* (input: CloudRuntimeTestInput) {
    yield* useVendor(input.runtimeId, (vendor, { apiKey }) =>
      Effect.tryPromise({
        try: () => vendor.listSandboxes(),
        catch: (cause) =>
          mapVendorError({
            runtimeId: input.runtimeId,
            operation: "test",
            cause,
            secrets: [apiKey],
          }),
      }).pipe(Effect.asVoid),
    );
    return yield* list();
  });

  const createSandbox = Effect.fn("CloudRuntimeService.createSandbox")(function* (
    input: CloudRuntimeSandboxCreateInput,
  ) {
    const metadata = safeCreateMetadata(input.metadata);
    const created = yield* useVendor(input.runtimeId, (vendor, { apiKey }) =>
      Effect.tryPromise({
        try: () =>
          vendor.createSandbox({
            ...(input.name ? { name: input.name } : {}),
            ...(metadata ? { metadata } : {}),
          }),
        catch: (cause) =>
          mapVendorError({
            runtimeId: input.runtimeId,
            operation: "create-sandbox",
            cause,
            secrets: [apiKey],
          }),
      }),
    );
    return yield* listSandboxes({ runtimeId: input.runtimeId }).pipe(
      Effect.onError(() => cleanupPreparedSandbox(input.runtimeId, created.sandboxId)),
    );
  });

  const listSandboxes = Effect.fn("CloudRuntimeService.listSandboxes")(function* (
    input: CloudRuntimeSandboxListInput,
  ) {
    const sandboxes = yield* useVendor(input.runtimeId, (vendor, { apiKey }) =>
      Effect.tryPromise({
        try: () => vendor.listSandboxes(),
        catch: (cause) =>
          mapVendorError({
            runtimeId: input.runtimeId,
            operation: "list-sandboxes",
            cause,
            secrets: [apiKey],
          }),
      }),
    );
    return {
      sandboxes: stampSandboxes(input.runtimeId, sandboxes),
    } satisfies CloudRuntimeSandboxListResult;
  });

  const sandboxAction = Effect.fn("CloudRuntimeService.sandboxAction")(function* (
    input: CloudRuntimeSandboxActionInput,
  ) {
    yield* useVendor(input.runtimeId, (vendor, { apiKey }) =>
      Effect.gen(function* () {
        const owned = yield* Effect.tryPromise({
          try: () => vendor.listSandboxes(),
          catch: (cause) =>
            mapVendorError({
              runtimeId: input.runtimeId,
              operation: "list-sandboxes",
              cause,
              secrets: [apiKey],
            }),
        });
        if (
          !owned.some(
            (sandbox) =>
              sandbox.sandboxId === input.sandboxId && isManagedSandbox(sandbox, input.runtimeId),
          )
        ) {
          return yield* new CloudRuntimeError({
            runtimeId: input.runtimeId,
            operation: `${input.action}-sandbox`,
            reason: "sandbox_not_found",
            message: "The sandbox does not belong to this cloud runtime.",
          });
        }
        yield* Effect.tryPromise({
          try: () => vendor.action(input.sandboxId, input.action),
          catch: (cause) =>
            mapVendorError({
              runtimeId: input.runtimeId,
              operation: `${input.action}-sandbox`,
              cause,
              secrets: [apiKey],
            }),
        }).pipe(Effect.asVoid);
      }),
    );
    return yield* listSandboxes({ runtimeId: input.runtimeId });
  });

  const execute = Effect.fn("CloudRuntimeService.execute")(function* (
    input: CloudRuntimeExecuteInput,
  ) {
    const result = yield* useVendor(input.runtimeId, (vendor, { apiKey }) =>
      Effect.gen(function* () {
        const owned = yield* Effect.tryPromise({
          try: () => vendor.listSandboxes(),
          catch: (cause) =>
            mapVendorError({
              runtimeId: input.runtimeId,
              operation: "list-sandboxes",
              cause,
              secrets: [apiKey],
            }),
        });
        if (
          !owned.some(
            (sandbox) =>
              sandbox.sandboxId === input.sandboxId && isManagedSandbox(sandbox, input.runtimeId),
          )
        ) {
          return yield* new CloudRuntimeError({
            runtimeId: input.runtimeId,
            operation: "execute",
            reason: "sandbox_not_found",
            message: "The sandbox does not belong to this cloud runtime.",
          });
        }
        return yield* Effect.tryPromise({
          try: () =>
            vendor.execute(input.sandboxId, {
              command: "/bin/sh",
              args: ["-lc", input.command],
              ...(input.cwd ? { cwd: input.cwd } : {}),
              env: {},
              timeoutSeconds: Number(input.timeoutSeconds),
            }),
          catch: (cause) =>
            mapVendorError({
              runtimeId: input.runtimeId,
              operation: "execute",
              cause,
              secrets: [apiKey],
            }),
        });
      }),
    );
    return result satisfies CloudRuntimeExecuteResult;
  });

  const prepareExecution = Effect.fn("CloudRuntimeService.prepareExecution")(function* (
    input: import("./CloudRuntimeService.ts").CloudExecutionPrepareInput,
  ) {
    const { config } = yield* requireConfig(input.runtimeId);
    const setupHash = NodeCrypto.createHash("sha256");
    for (const value of [
      config.kind,
      config.region ?? "",
      config.template ?? "",
      config.domain ?? "",
      config.apiUrl ?? "",
      String(config.autoPauseMinutes ?? ""),
      ...config.setupCommands,
    ]) {
      setupHash.update(String(value.length));
      setupHash.update(":");
      setupHash.update(value);
      setupHash.update("\u0000");
    }
    const setupHashValue = setupHash.digest("hex");
    const preparedSandbox = yield* useVendor(input.runtimeId, (vendor, { apiKey }) =>
      Effect.tryPromise({
        try: async () => {
          const existing = (await vendor.listSandboxes()).find(
            (candidate) =>
              candidate.name === input.name &&
              candidate.metadata?.t3ManagedExecution === "true" &&
              candidate.metadata?.t3RuntimeId === input.runtimeId &&
              candidate.metadata?.t3EnvironmentId === environmentId &&
              candidate.metadata.t3SetupHash === setupHashValue &&
              candidate.metadata.t3ProviderInstanceId === input.metadata?.t3ProviderInstanceId &&
              candidate.state !== "stopped" &&
              candidate.state !== "error",
          );
          if (existing) {
            if (existing.state === "paused") await vendor.action(existing.sandboxId, "resume");
            return { sandbox: existing, created: false };
          }
          const created = await vendor.createSandbox({
            name: input.name,
            metadata: {
              ...input.metadata,
              t3ManagedExecution: "true",
              t3SetupHash: setupHashValue,
              t3ProviderInstanceId: input.metadata?.t3ProviderInstanceId ?? "unknown",
            },
          });
          return { sandbox: created, created: true };
        },
        catch: (cause) =>
          mapVendorError({
            runtimeId: input.runtimeId,
            operation: "prepare-execution",
            cause,
            secrets: [apiKey],
          }),
      }),
    );
    const { sandbox, created } = preparedSandbox;
    return yield* Effect.gen(function* () {
      const remoteCwd = `/workspace/${input.name.replaceAll(/[^a-zA-Z0-9_-]/gu, "-")}`;
      const remoteHome = `/tmp/t3-home-${sandbox.sandboxId.replaceAll(/[^a-zA-Z0-9_-]/gu, "-")}`;
      const archiveName = `t3-workspace-${sandbox.sandboxId.replaceAll(/[^a-zA-Z0-9_-]/gu, "-")}.tar`;
      const remoteArchive = `/tmp/${archiveName}`;
      const workspaceArchive = input.workspaceArchive;
      if (workspaceArchive) {
        yield* useVendor(input.runtimeId, (vendor, { apiKey }) =>
          Effect.tryPromise({
            try: () => vendor.uploadFile(sandbox.sandboxId, remoteArchive, workspaceArchive),
            catch: (cause) =>
              mapVendorError({
                runtimeId: input.runtimeId,
                operation: "upload-workspace",
                cause,
                secrets: [apiKey, ...config.setupCommands],
              }),
          }),
        );
      }
      const commands = [
        {
          command: `mkdir -p ${shellQuote(remoteHome)} && rm -rf ${shellQuote(remoteCwd)} && mkdir -p ${shellQuote(remoteCwd)}${
            input.workspaceArchive
              ? ` && tar -xf ${shellQuote(remoteArchive)} -C ${shellQuote(remoteCwd)} && rm -f ${shellQuote(remoteArchive)}`
              : ""
          }`,
          cwd: "/",
        },
        ...config.setupCommands.map((command) => ({ command, cwd: remoteCwd })),
      ];
      for (const { command, cwd } of commands) {
        const result = yield* useVendor(input.runtimeId, (vendor, { apiKey }) =>
          Effect.tryPromise({
            try: () =>
              vendor.execute(sandbox.sandboxId, {
                command: "/bin/sh",
                args: ["-lc", command],
                cwd,
                env: { HOME: remoteHome },
                timeoutSeconds: 300,
              }),
            catch: (cause) =>
              mapVendorError({
                runtimeId: input.runtimeId,
                operation: "prepare-execution-command",
                cause,
                secrets: [apiKey, ...config.setupCommands],
              }),
          }),
        );
        if (result.exitCode !== 0) {
          return yield* new CloudRuntimeError({
            runtimeId: input.runtimeId,
            operation: "prepare-execution-command",
            reason: "operation_failed",
            message: `Cloud setup command failed with exit code ${result.exitCode}.`,
          });
        }
      }
      return {
        schemaVersion: 1,
        runtimeId: input.runtimeId,
        kind: config.kind,
        sandboxId: sandbox.sandboxId,
        remoteCwd,
        remoteHome,
        owned: true,
      } satisfies CloudExecutionHandle;
    }).pipe(
      Effect.onError(() =>
        created ? cleanupPreparedSandbox(input.runtimeId, sandbox.sandboxId) : Effect.void,
      ),
    );
  });

  const startProcess = Effect.fn("CloudRuntimeService.startProcess")(function* (
    runtimeId: CloudRuntimeId,
    sandboxId: string,
    command: CloudCommandSpec,
  ) {
    const { config, apiKey } = yield* requireConfig(runtimeId);
    if (!apiKey) {
      return yield* new CloudRuntimeError({
        runtimeId,
        operation: "start-process",
        reason: "credential_missing",
        message: "Add an API key for this cloud runtime.",
      });
    }
    const vendor = yield* Effect.try({
      try: () => makeVendor({ runtimeId, config, apiKey, environmentId }),
      catch: (cause) =>
        mapVendorError({ runtimeId, operation: "create-client", cause, secrets: [apiKey] }),
    });
    const owned = yield* Effect.tryPromise({
      try: () => vendor.listSandboxes(),
      catch: (cause) =>
        mapVendorError({ runtimeId, operation: "list-sandboxes", cause, secrets: [apiKey] }),
    }).pipe(Effect.onError(() => closeVendor(vendor)));
    if (
      !owned.some(
        (sandbox) => sandbox.sandboxId === sandboxId && isManagedSandbox(sandbox, runtimeId),
      )
    ) {
      yield* closeVendor(vendor);
      return yield* new CloudRuntimeError({
        runtimeId,
        operation: "start-process",
        reason: "sandbox_not_found",
        message: "The sandbox does not belong to this cloud runtime.",
      });
    }
    return yield* Effect.tryPromise({
      try: () => vendor.startProcess(sandboxId, command),
      catch: (cause) =>
        mapVendorError({
          runtimeId,
          operation: "start-process",
          cause,
          secrets: [apiKey, ...Object.values(command.env)],
        }),
    }).pipe(
      Effect.onError(() => closeVendor(vendor)),
      Effect.tap((process) =>
        Effect.sync(() => {
          void process.wait().then(
            () => Effect.runPromise(closeVendor(vendor)),
            () => Effect.runPromise(closeVendor(vendor)),
          );
        }),
      ),
    );
  });

  return {
    list,
    setCredential,
    clearCredential,
    test,
    createSandbox,
    listSandboxes,
    sandboxAction,
    execute,
    withVendor: useVendor,
    prepareExecution,
    startProcess,
  } satisfies CloudRuntimeServiceShape;
});

export const CloudRuntimeServiceLive = Layer.effect(CloudRuntimeService, makeCloudRuntimeService());
