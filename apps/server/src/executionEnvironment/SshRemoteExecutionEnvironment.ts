import {
  EnvironmentId,
  type DesktopSshEnvironmentTarget,
  type ExecutionEnvironmentContract,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  type ExecutionEnvironmentAdapter,
  type ExecutionEnvironmentAdapterCapabilities,
  type ExecutionEnvironmentProvisionInput,
  type ExecutionEnvironmentRef,
  type ResolvedExecutionEnvironment,
  ExecutionEnvironmentError,
} from "./ExecutionEnvironmentRegistry.ts";

/**
 * SSH Remote execution environment adapter.
 *
 * The existing T3 SSH behavior is preserved unchanged: T3 starts or reuses a T3
 * server on the target host, the remote host owns the files, git state,
 * terminals and agent sessions, and an SSH tunnel exposes the remote server's
 * HTTP/WS endpoints on loopback. This adapter wraps {@link SshEnvironmentManager}
 * so SSH Remote participates in the common execution environment abstraction.
 *
 * The {@link DesktopSshEnvironmentTarget} is the persisted identity of an SSH
 * environment (alias/hostname/user/port). Lifecycle ops that don't apply
 * (pause/resume/delete of someone else's machine) return "unsupported".
 */
export interface SshRemoteAdapterDeps {
  readonly ensureEnvironment: (
    target: DesktopSshEnvironmentTarget,
    options?: { readonly issuePairingToken?: boolean },
  ) => Effect.Effect<
    {
      readonly target: DesktopSshEnvironmentTarget;
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
      readonly pairingToken: string | null;
      readonly remotePort?: number;
      readonly remoteServerKind?: "external" | "managed";
    },
    unknown
  >;
  readonly disconnectEnvironment: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<void, unknown>;
  /** Resolve the target for a persisted environment id (from saved environments). */
  readonly resolveTarget: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<DesktopSshEnvironmentTarget, ExecutionEnvironmentError>;
}

const sshCapabilities: ExecutionEnvironmentAdapterCapabilities = {
  category: "ssh-remote",
  create: true,
  reconnect: true,
  status: true,
  start: false,
  stop: false,
  pause: false,
  resume: false,
  delete: false,
};

const unsupported = (operation: string): Effect.Effect<never, ExecutionEnvironmentError> =>
  Effect.fail(
    new ExecutionEnvironmentError({
      operation,
      category: "ssh-remote",
      detail: "The SSH remote execution environment does not support this lifecycle operation.",
    }),
  );

export const makeSshRemoteAdapter = (deps: SshRemoteAdapterDeps): ExecutionEnvironmentAdapter => {
  const connectViaTarget = Effect.fn("SshRemoteExecutionEnvironment.connectViaTarget")(function* (
    target: DesktopSshEnvironmentTarget,
  ) {
    const bootstrap = yield* deps.ensureEnvironment(target).pipe(
      Effect.mapError(
        (cause) =>
          new ExecutionEnvironmentError({
            operation: "connect",
            category: "ssh-remote",
            detail: `Could not establish the SSH environment for ${target.alias || target.hostname}.`,
            cause,
          }),
      ),
    );
    const httpBaseUrl = bootstrap.httpBaseUrl;
    const wsBaseUrl = bootstrap.wsBaseUrl ?? null;
    // The environment id is not known until the remote descriptor is fetched;
    // callers that already have one (saved environments) keep it. For a freshly
    // connected environment, mint a placeholder derived from the target so the
    // contract is non-empty until descriptor resolution completes upstream.
    const environmentId = EnvironmentId.make(`ssh:${target.alias || target.hostname}`);
    const contract: ExecutionEnvironmentContract = {
      environmentId,
      label: target.alias || target.hostname,
      category: "ssh-remote",
      state: "running",
      httpBaseUrl,
      wsBaseUrl,
    };
    return { contract, httpBaseUrl, wsBaseUrl: bootstrap.wsBaseUrl } satisfies ResolvedExecutionEnvironment;
  });

  return {
    capabilities: sshCapabilities,

    resolve: (ref: ExecutionEnvironmentRef) =>
      Effect.gen(function* () {
        const target = yield* deps.resolveTarget(ref.environmentId);
        const resolved = yield* connectViaTarget(target);
        return resolved.contract;
      }),

    connect: (ref: ExecutionEnvironmentRef) =>
      Effect.gen(function* () {
        const target = yield* deps.resolveTarget(ref.environmentId);
        return yield* connectViaTarget(target);
      }),

    create: (input: ExecutionEnvironmentProvisionInput) =>
      Effect.gen(function* () {
        // For SSH, "create" means ensure an environment for a target the caller
        // described by label. The concrete target resolution is owned by the
        // saved-environment layer; here we expect an existing target alias.
        const target = yield* deps.resolveTarget(EnvironmentId.make(input.label));
        return yield* connectViaTarget(target);
      }),

    status: (_ref: ExecutionEnvironmentRef) => Effect.succeed("running"),

    start: () => unsupported("start"),
    stop: () => unsupported("stop"),
    pause: () => unsupported("pause"),
    resume: () => unsupported("resume"),
    delete: (ref: ExecutionEnvironmentRef) =>
      Effect.gen(function* () {
        const target = yield* deps.resolveTarget(ref.environmentId);
        yield* deps.disconnectEnvironment(target).pipe(
          Effect.mapError(
            (cause) =>
              new ExecutionEnvironmentError({
                operation: "delete",
                category: "ssh-remote",
                detail: "Could not disconnect the SSH environment.",
                cause,
              }),
          ),
        );
      }),
  };
};
