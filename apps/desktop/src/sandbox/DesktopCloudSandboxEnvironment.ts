import {
  type CloudSandboxAssociationInput,
  type CloudSandboxCreateInput,
  type CloudSandboxEnsureInput,
  type CloudSandboxLifecycleInput,
  type CloudSandboxProviderConnection,
  type CloudSandboxProviderConnectionInput,
  type CloudSandboxRecord,
  type DesktopCloudSandboxBootstrap,
  type DesktopSshEnvironmentTarget,
  ExecutionEnvironmentOperationError,
} from "@t3tools/contracts";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import { redactGitHubSecrets } from "@t3tools/github";
import {
  buildSandboxLaunchCommand,
  buildSandboxPairingCommand,
  buildSandboxStopCommand,
  makeSandboxProvider,
  parseSandboxPairingCredential,
  T3_SANDBOX_SERVER_PORT,
  type SandboxProviderAdapter,
  type SandboxSshAccess,
} from "@t3tools/sandbox";
import { buildRemoteT3RunnerScript, type RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as DesktopIntegrationStore from "../app/DesktopIntegrationStore.ts";
import * as DesktopSshEnvironment from "../ssh/DesktopSshEnvironment.ts";

interface DaytonaTransport {
  readonly target: DesktopSshEnvironmentTarget;
  readonly access: SandboxSshAccess;
}

export interface DesktopCloudSandboxEnvironmentLayerOptions {
  readonly resolveCliRunner: Effect.Effect<RemoteT3RunnerOptions>;
}

export class DesktopCloudSandboxEnvironment extends Context.Service<
  DesktopCloudSandboxEnvironment,
  {
    readonly listProviderConnections: Effect.Effect<
      readonly CloudSandboxProviderConnection[],
      ExecutionEnvironmentOperationError
    >;
    readonly saveProviderConnection: (
      input: CloudSandboxProviderConnectionInput,
    ) => Effect.Effect<CloudSandboxProviderConnection, ExecutionEnvironmentOperationError>;
    readonly validateProviderConnection: (
      id: string,
    ) => Effect.Effect<CloudSandboxProviderConnection, ExecutionEnvironmentOperationError>;
    readonly removeProviderConnection: (
      id: string,
    ) => Effect.Effect<void, ExecutionEnvironmentOperationError>;
    readonly listSandboxes: Effect.Effect<
      readonly CloudSandboxRecord[],
      ExecutionEnvironmentOperationError
    >;
    readonly createSandbox: (
      input: CloudSandboxCreateInput,
    ) => Effect.Effect<CloudSandboxRecord, ExecutionEnvironmentOperationError>;
    readonly ensureSandbox: (
      input: CloudSandboxEnsureInput,
    ) => Effect.Effect<DesktopCloudSandboxBootstrap, ExecutionEnvironmentOperationError>;
    readonly disconnectSandbox: (
      target: CloudSandboxEnsureInput["target"],
    ) => Effect.Effect<void, ExecutionEnvironmentOperationError>;
    readonly lifecycle: (
      input: CloudSandboxLifecycleInput,
    ) => Effect.Effect<CloudSandboxRecord | null, ExecutionEnvironmentOperationError>;
    readonly associateProject: (
      input: CloudSandboxAssociationInput,
    ) => Effect.Effect<CloudSandboxRecord, ExecutionEnvironmentOperationError>;
  }
>()("@t3tools/desktop/sandbox/DesktopCloudSandboxEnvironment") {}

function socketBaseUrl(httpBaseUrl: string): string {
  const url = new URL(httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export const make = Effect.fn("desktop.cloudSandbox.make")(function* (
  options: DesktopCloudSandboxEnvironmentLayerOptions,
) {
  const store = yield* DesktopIntegrationStore.DesktopIntegrationStore;
  const ssh = yield* DesktopSshEnvironment.DesktopSshEnvironment;
  const httpClient = yield* HttpClient.HttpClient;
  const daytonaTransports = yield* Ref.make(new Map<string, DaytonaTransport>());

  const operationError = (
    operation: string,
    cause: unknown,
    provider?: CloudSandboxRecord["provider"],
    secret?: string,
  ) => {
    const rawDetail = cause instanceof Error ? cause.message : String(cause);
    const detail = String(redactGitHubSecrets(rawDetail, secret ? [secret] : []));
    return new ExecutionEnvironmentOperationError({
      category: "cloud-sandbox",
      operation,
      ...(provider ? { provider } : {}),
      detail,
    });
  };

  const resolveProvider = Effect.fn("desktop.cloudSandbox.resolveProvider")(function* (
    connectionId: string,
  ) {
    const stored = yield* store
      .getProviderConnection(connectionId)
      .pipe(Effect.mapError((cause) => operationError("load-provider", cause)));
    if (Option.isNone(stored)) {
      return yield* operationError(
        "load-provider",
        new Error(`Sandbox provider connection ${connectionId} does not exist.`),
      );
    }
    return {
      stored: stored.value,
      adapter: makeSandboxProvider({
        kind: stored.value.connection.provider,
        connectionId: stored.value.connection.id,
        credential: {
          apiKey: stored.value.apiKey,
          ...(stored.value.connection.apiUrl ? { apiUrl: stored.value.connection.apiUrl } : {}),
        },
      }),
    };
  });

  const callProvider = <A>(input: {
    readonly provider: CloudSandboxRecord["provider"];
    readonly operation: string;
    readonly secret: string;
    readonly action: () => Promise<A>;
  }): Effect.Effect<A, ExecutionEnvironmentOperationError> =>
    Effect.tryPromise({
      try: input.action,
      catch: (cause) => operationError(input.operation, cause, input.provider, input.secret),
    });

  const withAssociation = Effect.fn("desktop.cloudSandbox.withAssociation")(function* (
    record: CloudSandboxRecord,
  ) {
    const association = yield* store
      .getAssociation(record.providerConnectionId, record.sandboxId)
      .pipe(Effect.mapError((cause) => operationError("load-association", cause, record.provider)));
    return { ...record, associatedProject: Option.getOrNull(association) };
  });

  const ensureDaytona = Effect.fn("desktop.cloudSandbox.ensureDaytona")(function* (input: {
    readonly adapter: SandboxProviderAdapter;
    readonly secret: string;
    readonly sandbox: CloudSandboxRecord;
    readonly issuePairingToken: boolean;
  }) {
    if (!input.adapter.createSshAccess) {
      return yield* operationError(
        "create-ssh-access",
        new Error("The Daytona adapter does not expose SSH access."),
        "daytona",
      );
    }
    const key = `${input.sandbox.providerConnectionId}:${input.sandbox.sandboxId}`;
    const isUsable = (transport: DaytonaTransport, now: number) => {
      const expiresAt = Date.parse(transport.access.expiresAt);
      return Number.isFinite(expiresAt) && expiresAt > now + 30_000;
    };
    const cleanupTransport = (transport: DaytonaTransport) =>
      ssh.disconnectEnvironment(transport.target).pipe(
        Effect.ignore,
        Effect.andThen(Effect.tryPromise(() => transport.access.revoke()).pipe(Effect.ignore)),
      );
    const now = yield* Clock.currentTimeMillis;
    const active = (yield* Ref.get(daytonaTransports)).get(key);
    let transport = active && isUsable(active, now) ? active : undefined;
    if (!transport) {
      const access = yield* callProvider({
        provider: "daytona",
        operation: "create-ssh-access",
        secret: input.secret,
        action: () => input.adapter.createSshAccess!(input.sandbox.sandboxId, 60),
      });
      const candidate: DaytonaTransport = {
        access,
        target: {
          alias: access.hostname,
          hostname: access.hostname,
          username: access.username,
          port: access.port,
        },
      };
      const compareAt = yield* Clock.currentTimeMillis;
      const decision = yield* Ref.modify(daytonaTransports, (current) => {
        const existing = current.get(key);
        if (existing && isUsable(existing, compareAt)) {
          return [{ winner: existing, loser: candidate, stale: null }, current] as const;
        }
        const next = new Map(current);
        next.set(key, candidate);
        return [{ winner: candidate, loser: null, stale: existing ?? null }, next] as const;
      });
      if (decision.loser) yield* cleanupTransport(decision.loser);
      if (decision.stale) yield* cleanupTransport(decision.stale);
      transport = decision.winner;
    }
    const bootstrap = yield* ssh
      .ensureEnvironment(transport.target, { issuePairingToken: input.issuePairingToken })
      .pipe(
        Effect.mapError((cause) =>
          operationError("bootstrap-ssh", cause, "daytona", transport!.access.token),
        ),
      );
    return {
      httpBaseUrl: bootstrap.httpBaseUrl,
      wsBaseUrl: bootstrap.wsBaseUrl,
      pairingToken: bootstrap.pairingToken,
    };
  });

  const ensureApiTransport = Effect.fn("desktop.cloudSandbox.ensureApiTransport")(
    function* (input: {
      readonly adapter: SandboxProviderAdapter;
      readonly secret: string;
      readonly sandbox: CloudSandboxRecord;
      readonly issuePairingToken: boolean;
    }) {
      if (!input.adapter.runCommand || !input.adapter.getEndpoint) {
        return yield* operationError(
          "bootstrap",
          new Error(`${input.sandbox.provider} does not expose command and endpoint APIs.`),
          input.sandbox.provider,
        );
      }
      const runner = buildRemoteT3RunnerScript(yield* options.resolveCliRunner);
      const launch = yield* callProvider({
        provider: input.sandbox.provider,
        operation: "bootstrap",
        secret: input.secret,
        action: () =>
          input.adapter.runCommand!(input.sandbox.sandboxId, {
            command: buildSandboxLaunchCommand(runner),
            timeoutMs: 120_000,
          }),
      });
      if (launch.exitCode !== 0) {
        return yield* operationError(
          "bootstrap",
          new Error(launch.stderr || "The T3 server bootstrap command failed."),
          input.sandbox.provider,
          input.secret,
        );
      }
      const httpBaseUrl = yield* callProvider({
        provider: input.sandbox.provider,
        operation: "discover-endpoint",
        secret: input.secret,
        action: () => input.adapter.getEndpoint!(input.sandbox.sandboxId, T3_SANDBOX_SERVER_PORT),
      });
      let pairingToken: string | null = null;
      if (input.issuePairingToken) {
        const pairing = yield* callProvider({
          provider: input.sandbox.provider,
          operation: "issue-pairing-token",
          secret: input.secret,
          action: () =>
            input.adapter.runCommand!(input.sandbox.sandboxId, {
              command: buildSandboxPairingCommand(),
              timeoutMs: 30_000,
            }),
        });
        if (pairing.exitCode !== 0) {
          return yield* operationError(
            "issue-pairing-token",
            new Error(pairing.stderr || "The pairing command failed."),
            input.sandbox.provider,
            input.secret,
          );
        }
        pairingToken = yield* Effect.try({
          try: () => parseSandboxPairingCredential(pairing.stdout),
          catch: (cause) =>
            operationError("issue-pairing-token", cause, input.sandbox.provider, input.secret),
        });
      }
      return { httpBaseUrl, wsBaseUrl: socketBaseUrl(httpBaseUrl), pairingToken };
    },
  );

  const closeDaytonaTransport = Effect.fn("desktop.cloudSandbox.closeDaytonaTransport")(function* (
    providerConnectionId: string,
    sandboxId: string,
  ) {
    const key = `${providerConnectionId}:${sandboxId}`;
    const transport = yield* Ref.modify(daytonaTransports, (entries) => {
      const selected = entries.get(key);
      const next = new Map(entries);
      next.delete(key);
      return [selected, next] as const;
    });
    if (!transport) return;
    yield* ssh.disconnectEnvironment(transport.target).pipe(Effect.ignore);
    yield* Effect.tryPromise(() => transport.access.revoke()).pipe(Effect.ignore);
  });

  const closeAllDaytonaTransports = Effect.gen(function* () {
    const current = yield* Ref.getAndSet(daytonaTransports, new Map());
    yield* Effect.forEach(
      current,
      ([, transport]) =>
        ssh
          .disconnectEnvironment(transport.target)
          .pipe(
            Effect.ignore,
            Effect.andThen(Effect.tryPromise(() => transport.access.revoke()).pipe(Effect.ignore)),
          ),
      { concurrency: "unbounded", discard: true },
    );
  });

  yield* Effect.addFinalizer(() => closeAllDaytonaTransports);

  return DesktopCloudSandboxEnvironment.of({
    listProviderConnections: store.listProviderConnections.pipe(
      Effect.mapError((cause) => operationError("list-providers", cause)),
    ),
    saveProviderConnection: (input) =>
      store
        .saveProviderConnection(input)
        .pipe(
          Effect.mapError((cause) =>
            operationError("save-provider", cause, input.provider, input.apiKey),
          ),
        ),
    validateProviderConnection: (id) =>
      Effect.gen(function* () {
        const { stored, adapter } = yield* resolveProvider(id);
        yield* callProvider({
          provider: stored.connection.provider,
          operation: "validate-provider",
          secret: stored.apiKey,
          action: adapter.validate,
        });
        return yield* store
          .markProviderValidated(id)
          .pipe(
            Effect.mapError((cause) =>
              operationError("save-validation", cause, stored.connection.provider, stored.apiKey),
            ),
          );
      }),
    removeProviderConnection: (id) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(daytonaTransports);
        yield* Effect.forEach(
          [...current.keys()].filter((key) => key.startsWith(`${id}:`)),
          (key) => closeDaytonaTransport(id, key.slice(id.length + 1)),
          { discard: true },
        );
        yield* store
          .removeProviderConnection(id)
          .pipe(Effect.mapError((cause) => operationError("remove-provider", cause)));
      }),
    listSandboxes: Effect.gen(function* () {
      const connections = yield* store.listProviderConnections.pipe(
        Effect.mapError((cause) => operationError("list-providers", cause)),
      );
      return yield* Effect.forEach(
        connections,
        (connection) =>
          Effect.gen(function* () {
            const { stored, adapter } = yield* resolveProvider(connection.id);
            const records = yield* callProvider({
              provider: connection.provider,
              operation: "list",
              secret: stored.apiKey,
              action: adapter.list,
            });
            return yield* Effect.forEach(records, withAssociation);
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not list sandboxes for provider connection.", {
                providerConnectionId: connection.id,
                provider: connection.provider,
                detail: cause.detail,
              }).pipe(Effect.as<readonly CloudSandboxRecord[]>([])),
            ),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((groups) => groups.flat()));
    }),
    createSandbox: (input) =>
      Effect.gen(function* () {
        const { stored, adapter } = yield* resolveProvider(input.providerConnectionId);
        if (stored.connection.provider !== input.provider) {
          return yield* operationError(
            "create",
            new Error("The selected provider connection does not match the sandbox options."),
            input.provider,
          );
        }
        const record = yield* callProvider({
          provider: input.provider,
          operation: "create",
          secret: stored.apiKey,
          action: () => adapter.create(input),
        });
        if (input.associatedProject) {
          yield* store
            .setAssociation({
              providerConnectionId: record.providerConnectionId,
              sandboxId: record.sandboxId,
              project: input.associatedProject,
            })
            .pipe(
              Effect.mapError((cause) =>
                operationError("associate-project", cause, input.provider),
              ),
            );
        }
        return yield* withAssociation(record);
      }),
    ensureSandbox: (input) =>
      Effect.gen(function* () {
        const { stored, adapter } = yield* resolveProvider(input.target.providerConnectionId);
        if (stored.connection.provider !== input.target.provider) {
          return yield* operationError(
            "connect",
            new Error("The selected provider connection does not match this sandbox."),
            input.target.provider,
          );
        }
        const sandbox = yield* callProvider({
          provider: input.target.provider,
          operation: "connect",
          secret: stored.apiKey,
          action: () => adapter.connect(input.target.sandboxId),
        });
        const transport =
          input.target.provider === "daytona"
            ? yield* ensureDaytona({
                adapter,
                secret: stored.apiKey,
                sandbox,
                issuePairingToken: input.issuePairingToken ?? false,
              })
            : yield* ensureApiTransport({
                adapter,
                secret: stored.apiKey,
                sandbox,
                issuePairingToken: input.issuePairingToken ?? false,
              });
        const descriptor = yield* fetchRemoteEnvironmentDescriptor({
          httpBaseUrl: transport.httpBaseUrl,
          timeoutMs: 20_000,
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.mapError((cause) =>
            operationError("read-environment", cause, input.target.provider, stored.apiKey),
          ),
        );
        const bearerToken =
          transport.pairingToken === null
            ? null
            : (yield* bootstrapRemoteBearerSession({
                httpBaseUrl: transport.httpBaseUrl,
                credential: transport.pairingToken,
              }).pipe(
                Effect.provideService(HttpClient.HttpClient, httpClient),
                Effect.mapError((cause) =>
                  operationError(
                    "authorize-environment",
                    cause,
                    input.target.provider,
                    stored.apiKey,
                  ),
                ),
              )).access_token;
        return {
          target: input.target,
          sandbox: yield* withAssociation(sandbox),
          environmentId: descriptor.environmentId,
          label: descriptor.label,
          httpBaseUrl: transport.httpBaseUrl,
          wsBaseUrl: transport.wsBaseUrl,
          bearerToken,
        };
      }),
    disconnectSandbox: (target) =>
      closeDaytonaTransport(target.providerConnectionId, target.sandboxId),
    lifecycle: (input) =>
      Effect.gen(function* () {
        const { stored, adapter } = yield* resolveProvider(input.providerConnectionId);
        if (["stop", "pause", "delete"].includes(input.action)) {
          yield* closeDaytonaTransport(input.providerConnectionId, input.sandboxId);
          if (adapter.runCommand && input.action !== "delete") {
            yield* callProvider({
              provider: stored.connection.provider,
              operation: "stop-t3-server",
              secret: stored.apiKey,
              action: () =>
                adapter.runCommand!(input.sandboxId, { command: buildSandboxStopCommand() }),
            }).pipe(Effect.ignore);
          }
        }
        if (input.action === "delete") {
          yield* callProvider({
            provider: stored.connection.provider,
            operation: "delete",
            secret: stored.apiKey,
            action: () => adapter.delete(input.sandboxId),
          });
          yield* store
            .setAssociation({
              providerConnectionId: input.providerConnectionId,
              sandboxId: input.sandboxId,
              project: null,
            })
            .pipe(Effect.ignore);
          return null;
        }
        const action = adapter[input.action];
        if (typeof action !== "function") {
          return yield* operationError(
            input.action,
            new Error(`${stored.connection.provider} does not support ${input.action}.`),
            stored.connection.provider,
          );
        }
        const record = yield* callProvider({
          provider: stored.connection.provider,
          operation: input.action,
          secret: stored.apiKey,
          action: () => action.call(adapter, input.sandboxId),
        });
        return yield* withAssociation(record);
      }),
    associateProject: (input) =>
      Effect.gen(function* () {
        const { stored, adapter } = yield* resolveProvider(input.providerConnectionId);
        yield* store
          .setAssociation(input)
          .pipe(
            Effect.mapError((cause) =>
              operationError("associate-project", cause, stored.connection.provider, stored.apiKey),
            ),
          );
        const record = yield* callProvider({
          provider: stored.connection.provider,
          operation: "get",
          secret: stored.apiKey,
          action: () => adapter.get(input.sandboxId),
        });
        return yield* withAssociation(record);
      }),
  });
});

export const layer = (options: DesktopCloudSandboxEnvironmentLayerOptions) =>
  Layer.effect(DesktopCloudSandboxEnvironment, make(options));
