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
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { cloudRuntimeCredentialName } from "./credentialName.ts";
import { isManagedSandbox } from "./sandboxOwnership.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { CloudRuntimeService, type CloudRuntimeServiceShape } from "./CloudRuntimeService.ts";
import {
  makeCloudVendorAdapter,
  type CloudCommandSpec,
  type CloudVendorAdapter,
} from "./VendorAdapter.ts";

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The only sandbox states a turn may be run on. Everything else, including the
 * `unknown` this server assigns to a state string it does not recognise, is
 * treated as unusable: uploading a workspace and starting an agent on a
 * sandbox whose state nobody verified is worse than creating a fresh one.
 */
const isReusableSandboxState = (state: CloudSandboxSummary["state"]): boolean =>
  state === "running" || state === "paused";
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

  const resolveConfig = Effect.fnUntraced(function* (
    runtimeId: CloudRuntimeId,
    options?: { readonly requireEnabled?: boolean },
  ) {
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
    if (options?.requireEnabled !== false && !config.enabled) {
      return yield* new CloudRuntimeError({
        runtimeId,
        operation: "resolve-runtime",
        reason: "runtime_disabled",
        message: "The cloud runtime is disabled.",
      });
    }
    return { config, apiKey: yield* readCredential(runtimeId) };
  });

  /**
   * Execution requires an enabled runtime; sandbox lifecycle does not.
   *
   * `enabled` means "do not run turns here", not "forget the account". A
   * disabled runtime's sandboxes keep billing, and pausing or deleting them is
   * the only way to stop that, so `listSandboxes` and `sandboxAction` pass
   * `requireEnabled: false` and keep reaching the vendor.
   */
  const requireConfig = (runtimeId: CloudRuntimeId) => resolveConfig(runtimeId);

  const makeVendorFor = (runtimeId: CloudRuntimeId, options?: { requireEnabled?: boolean }) =>
    Effect.gen(function* () {
      const { config, apiKey } = yield* resolveConfig(runtimeId, options);
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
    options?: { readonly requireEnabled?: boolean },
  ): Effect.Effect<A, E | CloudRuntimeError, R> =>
    Effect.scoped(
      Effect.acquireRelease(makeVendorFor(runtimeId, options), ({ vendor }) =>
        closeVendor(vendor),
      ).pipe(Effect.flatMap(({ vendor, apiKey }) => use(vendor, { apiKey }))),
    );

  /**
   * A sandbox that failed setup is still a paid sandbox. Deleting it is the
   * only thing standing between a failed turn and a billing surprise, so a
   * failed delete is reported rather than dropped: the operator needs to know
   * which sandbox to remove by hand.
   */
  const cleanupPreparedSandbox = (runtimeId: CloudRuntimeId, sandboxId: string) =>
    useVendor(
      runtimeId,
      (vendor) => Effect.promise(() => vendor.action(sandboxId, "delete")).pipe(Effect.asVoid),
      { requireEnabled: false },
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Failed to delete a cloud sandbox after a failed preparation.", {
          runtimeId,
          sandboxId,
          cause,
        }),
      ),
    );

  const ownsSandbox = (sandbox: CloudSandboxSummary, runtimeId: CloudRuntimeId): boolean =>
    isManagedSandbox(sandbox, runtimeId, environmentId);

  /** Keeps only this runtime's sandboxes, and only the metadata clients may see. */
  const stampSandboxes = (runtimeId: CloudRuntimeId) =>
    Effect.map(
      (sandboxes: ReadonlyArray<CloudSandboxSummary>): ReadonlyArray<CloudSandboxSummary> =>
        sandboxes
          .filter((sandbox) => ownsSandbox(sandbox, runtimeId))
          .map((sandbox) => {
            const { metadata: _metadata, ...withoutMetadata } = sandbox;
            const metadata = publicSandboxMetadata(sandbox.metadata);
            return {
              ...withoutMetadata,
              runtimeId,
              ...(metadata ? { metadata } : {}),
            };
          }),
    );

  /**
   * Ownership is decided by server-stamped vendor metadata, never by anything
   * the client sends. A sandbox id alone would let one environment act on a
   * sandbox that shares the vendor account with it, and the vendor account can
   * legitimately be shared across environments.
   */
  const requireOwnedSandbox = Effect.fnUntraced(function* (
    runtimeId: CloudRuntimeId,
    sandboxId: string,
    vendor: CloudVendorAdapter,
    apiKey: string,
    operation: string,
  ) {
    const owned = yield* Effect.tryPromise({
      try: () => vendor.listSandboxes(),
      catch: (cause) =>
        mapVendorError({ runtimeId, operation: "list-sandboxes", cause, secrets: [apiKey] }),
    });
    if (
      !owned.some((sandbox) => sandbox.sandboxId === sandboxId && ownsSandbox(sandbox, runtimeId))
    ) {
      return yield* new CloudRuntimeError({
        runtimeId,
        operation,
        reason: "sandbox_not_found",
        message: "The sandbox does not belong to this cloud runtime.",
      });
    }
  });

  const listSandboxesFor = (
    runtimeId: CloudRuntimeId,
    config: CloudRuntimeConfig,
    apiKey: string,
  ) =>
    Effect.tryPromise({
      try: async () => {
        const vendor = makeVendor({ runtimeId, config, apiKey, environmentId });
        try {
          return await vendor.listSandboxes();
        } finally {
          await vendor.close?.();
        }
      },
      catch: (cause) => mapVendorError({ runtimeId, operation: "list", cause, secrets: [apiKey] }),
    }).pipe(stampSandboxes(runtimeId));

  const listOne = Effect.fnUntraced(function* (
    runtimeId: CloudRuntimeId,
    config: CloudRuntimeConfig,
  ) {
    const checkedAt = yield* nowIso;
    const apiKey = yield* readCredential(runtimeId);
    if (!apiKey) {
      return {
        id: runtimeId,
        config,
        hasCredential: false,
        health: {
          // A disabled runtime is not a configuration problem, so the reason
          // to add a key is only given when one is actually needed.
          status: config.enabled ? "unconfigured" : "disabled",
          message: config.enabled
            ? "Add an API key to test this cloud runtime."
            : "Cloud runtime is disabled.",
          checkedAt,
        } satisfies CloudRuntimeHealth,
        sandboxes: [],
      } satisfies CloudRuntimeInstance;
    }
    const listSandboxes = listSandboxesFor(runtimeId, config, apiKey);
    if (!config.enabled) {
      // Still enumerate: a disabled runtime's sandboxes keep billing, and
      // hiding them would leave no way to stop that from T3.
      const sandboxes = yield* listSandboxes.pipe(
        Effect.catch((error) =>
          Effect.logWarning("Failed to list the sandboxes of a disabled cloud runtime.", {
            runtimeId,
            cause: error,
          }).pipe(Effect.as([])),
        ),
      );
      return {
        id: runtimeId,
        config,
        hasCredential: true,
        health: {
          status: "disabled",
          message: "Cloud runtime is disabled.",
          checkedAt,
        } satisfies CloudRuntimeHealth,
        sandboxes,
      } satisfies CloudRuntimeInstance;
    }
    return yield* listSandboxes.pipe(
      Effect.map(
        (sandboxes) =>
          ({
            id: runtimeId,
            config,
            hasCredential: true,
            health: {
              status: "ready",
              message: null,
              checkedAt,
            } satisfies CloudRuntimeHealth,
            sandboxes,
          }) satisfies CloudRuntimeInstance,
      ),
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
    // Clearing is intentionally idempotent. Settings deletion and secret
    // cleanup can arrive in either order when a client removes a runtime.
    yield* withSettingsWriteLock(
      secretStore
        .remove(credentialName(runtimeId))
        .pipe(
          Effect.mapError((_cause) =>
            settingsError(runtimeId, "clear-credential", "Failed to remove the cloud credential."),
          ),
        ),
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
      // A non-success exit, not `onError`: a request the client abandoned has
      // already created a paid sandbox and needs the same cleanup. Success
      // keeps the sandbox, which is the point of creating it here.
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : cleanupPreparedSandbox(input.runtimeId, created.sandboxId),
      ),
    );
  });

  const listSandboxes = Effect.fn("CloudRuntimeService.listSandboxes")(function* (
    input: CloudRuntimeSandboxListInput,
  ) {
    const sandboxes = yield* useVendor(
      input.runtimeId,
      (vendor, { apiKey }) =>
        Effect.tryPromise({
          try: () => vendor.listSandboxes(),
          catch: (cause) =>
            mapVendorError({
              runtimeId: input.runtimeId,
              operation: "list-sandboxes",
              cause,
              secrets: [apiKey],
            }),
        }).pipe(stampSandboxes(input.runtimeId)),
      { requireEnabled: false },
    );
    return { sandboxes } satisfies CloudRuntimeSandboxListResult;
  });

  const sandboxAction = Effect.fn("CloudRuntimeService.sandboxAction")(function* (
    input: CloudRuntimeSandboxActionInput,
  ) {
    yield* useVendor(
      input.runtimeId,
      (vendor, { apiKey }) =>
        Effect.gen(function* () {
          yield* requireOwnedSandbox(
            input.runtimeId,
            input.sandboxId,
            vendor,
            apiKey,
            `${input.action}-sandbox`,
          );
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
      // Lifecycle stays reachable on a disabled runtime: pausing or deleting
      // a sandbox that is still billing is the whole point of disabling one.
      { requireEnabled: false },
    );
    return yield* listSandboxes({ runtimeId: input.runtimeId });
  });

  const execute = Effect.fn("CloudRuntimeService.execute")(function* (
    input: CloudRuntimeExecuteInput,
  ) {
    const result = yield* useVendor(input.runtimeId, (vendor, { apiKey }) =>
      Effect.gen(function* () {
        yield* requireOwnedSandbox(input.runtimeId, input.sandboxId, vendor, apiKey, "execute");
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
              // Only the two states a sandbox can be reused from. `unknown` is
              // deliberately excluded: it means this build did not recognise
              // the vendor's state string, and reusing an unrecognised sandbox
              // would run a turn on a machine whose state nobody verified.
              isReusableSandboxState(candidate.state),
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
    // A reused sandbox is not this call's to delete: an interrupted turn
    // preparation must not tear down a sandbox the next turn is using.
    const discardOnFailure = () =>
      created ? cleanupPreparedSandbox(input.runtimeId, sandbox.sandboxId) : Effect.void;
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
      // A non-success exit, not `onError`: an interrupted preparation has
      // already created a paid sandbox and needs the same cleanup as a failed
      // one. Success keeps the sandbox for the turn that is about to use it.
    }).pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : discardOnFailure())));
  });

  /**
   * The vendor client outlives the spawn call, so its ownership is explicit:
   * the returned process closes it once the process exits. A failure or an
   * interruption before that handover closes it here instead, which
   * `Effect.onError` alone would miss.
   */
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
    const { vendor } = yield* makeVendorFor(runtimeId);
    const cloudProcess = yield* requireOwnedSandbox(
      runtimeId,
      sandboxId,
      vendor,
      apiKey,
      "start-process",
    ).pipe(
      Effect.flatMap(() =>
        Effect.tryPromise({
          try: () => vendor.startProcess(sandboxId, command),
          catch: (cause) =>
            mapVendorError({
              runtimeId,
              operation: "start-process",
              cause,
              secrets: [apiKey, ...Object.values(command.env)],
            }),
        }),
      ),
      Effect.onError(() => closeVendor(vendor)),
    );
    // Closing the client is a promise the spawn call cannot make on the
    // process's behalf, so it is handed to a detached fiber rather than run
    // from a nested `Effect.runPromise` (which would resolve services outside
    // the surrounding context).
    yield* Effect.forkDetach(
      Effect.promise(() => cloudProcess.wait()).pipe(
        Effect.ignore,
        Effect.andThen(closeVendor(vendor)),
      ),
    );
    return cloudProcess;
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
