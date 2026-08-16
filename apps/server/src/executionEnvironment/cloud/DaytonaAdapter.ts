import {
  type CloudSandbox,
  type SandboxLifecycleCapabilities,
  type SandboxProviderValidationResult,
  type SandboxProvisionOptions,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  type SandboxConnectionTarget,
  type SandboxProviderAdapter,
  type SandboxProviderProvisionInput,
  SandboxProviderError,
} from "./SandboxProvider.ts";

/**
 * Daytona sandbox provider adapter.
 *
 * Daytona exposes a TypeScript SDK (`@daytonaio/sdk`/`@daytona/sdk`) with full
 * sandbox lifecycle (create/start/stop/delete/archive/snapshot), auto-stop and
 * auto-archive policies, and — importantly for T3 — programmatic SSH access via
 * `sandbox.createSshAccess()`. Because Daytona supports SSH, we reuse T3's
 * existing SSH bootstrap and remote-server architecture: provision the sandbox,
 * create a short-lived SSH access token, and hand the SSH target to the SSH
 * remote adapter. The remote host then owns files, git state, terminals and
 * agent sessions exactly as a normal SSH environment does.
 *
 * The SDK is loaded lazily so `@daytonaio/sdk` is an optional peer dependency:
 * a build without Daytona installed still compiles, and only fails at runtime
 * when a user actually configures a Daytona provider.
 */
const daytonaCapabilities: SandboxLifecycleCapabilities = {
  create: true,
  reconnect: true,
  status: true,
  start: true,
  stop: true,
  pause: false,
  resume: false,
  delete: true,
  resourceInfo: true,
  region: true,
  autoStop: true,
};

/** Lazy-load the Daytona SDK so it remains an optional dependency. */
async function loadDaytonaSdk(apiKey: string, apiUrl?: string): Promise<unknown> {
  try {
    const mod = await import("@daytonaio/sdk");
    const Daytona = (mod as { Daytona?: new (opts?: unknown) => unknown }).Daytona;
    if (!Daytona) {
      throw new SandboxProviderError({
        providerKind: "daytona",
        operation: "loadSdk",
        detail: "@daytonaio/sdk did not export a Daytona client.",
      });
    }
    return new Daytona(apiUrl ? { apiKey, apiUrl } : { apiKey });
  } catch (cause) {
    throw new SandboxProviderError({
      providerKind: "daytona",
      operation: "loadSdk",
      detail:
        "The @daytonaio/sdk package is not installed. Install it to use the Daytona sandbox provider.",
      cause: cause as never,
    });
  }
}

interface DaytonaSandboxLike {
  id: string;
  getInfo?: () => Promise<{ state?: string; name?: string; region?: string }>;
  createSshAccess?: (expiresInMinutes?: number) => Promise<{
    token?: string;
    host?: string;
    port?: number;
    login?: string;
  }>;
  start?: () => Promise<void>;
  stop?: () => Promise<void>;
  delete?: (timeout?: number, wait?: boolean) => Promise<void>;
}

interface DaytonaClientLike {
  create?: (input?: unknown) => Promise<DaytonaSandboxLike>;
  get?: (id: string) => Promise<DaytonaSandboxLike>;
}

const toSandboxState = (raw: string | undefined): CloudSandbox["state"] => {
  switch ((raw ?? "").toLowerCase()) {
    case "started":
    case "running":
      return "running";
    case "stopped":
      return "stopped";
    case "creating":
    case "pulling":
      return "creating";
    case "destroyed":
      return "deleted";
    case "error":
    case "failed":
      return "error";
    default:
      return "running";
  }
};

const toCloudSandbox = (sandbox: DaytonaSandboxLike, info?: {
  state?: string;
  name?: string;
  region?: string;
}): CloudSandbox => ({
  sandboxId: sandbox.id,
  providerKind: "daytona",
  label: info?.name ?? sandbox.id,
  state: toSandboxState(info?.state),
  region: info?.region ?? null,
  createdAt: new Date().toISOString(),
});

export interface DaytonaAdapterDeps {
  readonly credentialKey: string;
  readonly getApiKey: () => Effect.Effect<string, SandboxProviderError>;
  readonly apiUrl?: string;
}

export const makeDaytonaAdapter = (deps: DaytonaAdapterDeps): SandboxProviderAdapter => {
  const runOp = Effect.fn("DaytonaAdapter.runOp")(function* <A>(
    op: string,
    use: (client: DaytonaClientLike) => Promise<A>,
  ) {
    const apiKey = yield* deps.getApiKey();
    const client = (yield* Effect.tryPromise({
      try: () => loadDaytonaSdk(apiKey, deps.apiUrl),
      catch: (cause) =>
        new SandboxProviderError({
          providerKind: "daytona",
          operation: "loadSdk",
          detail:
            (cause as SandboxProviderError)?.detail ??
            "The @daytonaio/sdk package is not installed. Install it to use the Daytona sandbox provider.",
          cause: cause as never,
        }),
    })) as DaytonaClientLike;
    return yield* Effect.tryPromise({
      try: () => use(client),
      catch: (cause) =>
        new SandboxProviderError({
          providerKind: "daytona",
          operation: op,
          detail: "Daytona SDK call failed.",
          cause: cause as never,
        }),
    });
  });

  const fetchSandbox = Effect.fn("DaytonaAdapter.fetchSandbox")(function* (
    sandboxId: string,
    op: string,
  ) {
    const sandbox = yield* runOp(op, async (client) => client.get!(sandboxId));
    const info = yield* Effect.tryPromise({
      try: () => sandbox.getInfo?.() ?? Promise.resolve({}),
      catch: () => undefined as never,
    }).pipe(Effect.orElseSucceed(() => ({}) as { state?: string; name?: string; region?: string }));
    return { sandbox, info };
  });

  return {
    kind: "daytona",
    capabilities: daytonaCapabilities,

    validateConnection: () =>
      Effect.gen(function* () {
        const ok = yield* runOp("validateConnection", async (client) => typeof client.get === "function").pipe(
          Effect.match({ onFailure: () => false, onSuccess: () => true }),
        );
        return { ok, detail: ok ? null : "Could not reach the Daytona API with the stored key." } satisfies SandboxProviderValidationResult;
      }),

    createSandbox: (input: SandboxProviderProvisionInput) =>
      Effect.gen(function* () {
        const sandbox = yield* runOp("createSandbox", async (client) => {
          if (!client.create) throw new Error("Daytona client.create is unavailable");
          return client.create({
            name: input.label,
            ...(input.options?.template ? { template: input.options.template } : {}),
            ...(input.options?.region ? { region: input.options.region } : {}),
            ...(input.options?.autoStopSeconds
              ? { autoStopInterval: Math.round(input.options.autoStopSeconds / 60) }
              : {}),
          });
        });
        const info = yield* Effect.tryPromise({
          try: () => sandbox.getInfo?.() ?? Promise.resolve({}),
          catch: () => undefined as never,
        }).pipe(Effect.orElseSucceed(() => ({}) as { state?: string; name?: string; region?: string }));
        return toCloudSandbox(sandbox, info);
      }),

    reconnectSandbox: (sandboxId: string) =>
      Effect.gen(function* () {
        const { sandbox, info } = yield* fetchSandbox(sandboxId, "reconnectSandbox");
        return toCloudSandbox(sandbox, info);
      }),

    getSandbox: (sandboxId: string) =>
      Effect.gen(function* () {
        const { sandbox, info } = yield* fetchSandbox(sandboxId, "getSandbox");
        return toCloudSandbox(sandbox, info);
      }),

    startSandbox: (sandboxId: string) =>
      Effect.gen(function* () {
        const { sandbox, info } = yield* fetchSandbox(sandboxId, "startSandbox");
        yield* Effect.tryPromise({
          try: () => sandbox.start?.() ?? Promise.resolve(),
          catch: (cause) =>
            new SandboxProviderError({
              providerKind: "daytona",
              operation: "startSandbox",
              detail: "Could not start the Daytona sandbox.",
              cause: cause as never,
            }),
        });
        return toCloudSandbox(sandbox, info);
      }),

    stopSandbox: (sandboxId: string) =>
      Effect.gen(function* () {
        const { sandbox, info } = yield* fetchSandbox(sandboxId, "stopSandbox");
        yield* Effect.tryPromise({
          try: () => sandbox.stop?.() ?? Promise.resolve(),
          catch: (cause) =>
            new SandboxProviderError({
              providerKind: "daytona",
              operation: "stopSandbox",
              detail: "Could not stop the Daytona sandbox.",
              cause: cause as never,
            }),
        });
        return toCloudSandbox(sandbox, info);
      }),

    pauseSandbox: () =>
      Effect.fail(
        new SandboxProviderError({
          providerKind: "daytona",
          operation: "pause",
          detail: "Daytona does not support pausing a sandbox; use stop/start.",
        }),
      ),

    resumeSandbox: () =>
      Effect.fail(
        new SandboxProviderError({
          providerKind: "daytona",
          operation: "resume",
          detail: "Daytona does not support resuming a paused sandbox; use start.",
        }),
      ),

    deleteSandbox: (sandboxId: string) =>
      Effect.gen(function* () {
        const { sandbox } = yield* fetchSandbox(sandboxId, "deleteSandbox");
        yield* Effect.tryPromise({
          try: () => sandbox.delete?.(60, true) ?? Promise.resolve(),
          catch: (cause) =>
            new SandboxProviderError({
              providerKind: "daytona",
              operation: "deleteSandbox",
              detail: "Could not delete the Daytona sandbox.",
              cause: cause as never,
            }),
        });
      }),

    resolveConnectionTarget: (sandboxId: string) =>
      Effect.gen(function* () {
        const { sandbox } = yield* fetchSandbox(sandboxId, "resolveConnectionTarget");
        const ssh = yield* Effect.tryPromise({
          try: () =>
            sandbox.createSshAccess?.(60) ??
            Promise.reject(new Error("Daytona createSshAccess is unavailable")),
          catch: (cause) =>
            new SandboxProviderError({
              providerKind: "daytona",
              operation: "resolveConnectionTarget",
              detail: "Could not create Daytona SSH access. Verify the sandbox is running.",
              cause: cause as never,
            }),
        });
        // Daytona exposes SSH via ssh.app.daytona.io; the SDK returns host/port/login/token.
        const target: SandboxConnectionTarget = {
          sandboxId,
          transport: "ssh",
          sshTarget: {
            alias: `daytona-${sandboxId}`,
            hostname: ssh.host ?? "ssh.app.daytona.io",
            username: ssh.login ?? null,
            port: ssh.port ?? null,
          },
        };
        return target;
      }),
  };
};

/** Options supported by Daytona provisioning (used to type-narrow UI fields). */
export type DaytonaProvisionOptions = SandboxProvisionOptions;
