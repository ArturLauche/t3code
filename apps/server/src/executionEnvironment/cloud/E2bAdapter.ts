import {
  type CloudSandbox,
  type SandboxLifecycleCapabilities,
  type SandboxProviderValidationResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  type SandboxConnectionTarget,
  type SandboxProviderAdapter,
  type SandboxProviderProvisionInput,
  SandboxProviderError,
} from "./SandboxProvider.ts";

/**
 * E2B sandbox provider adapter.
 *
 * E2B provides a TypeScript sandbox SDK (`e2b`) with command, filesystem and
 * lifecycle APIs. E2B sandboxes do not expose SSH; their networking model is an
 * HTTP/WebSocket service surface driven by the SDK. Rather than pretending E2B
 * supports SSH, this adapter implements a provider transport adapter that
 * resolves to an HTTP connection target the T3 backend can drive.
 *
 * Lifecycle reflects E2B's real capabilities: `pause()`/`connect()` (resume)
 * save full memory + filesystem state, `kill()` permanently deletes, and
 * `getInfo()` reports state. There is no separate "stop" without pause; stop
 * maps to kill when the sandbox is not meant to be resumed.
 *
 * The SDK is loaded lazily so `e2b` is an optional peer dependency.
 */
const e2bCapabilities: SandboxLifecycleCapabilities = {
  create: true,
  reconnect: true,
  status: true,
  start: false,
  stop: true,
  pause: true,
  resume: true,
  delete: true,
  resourceInfo: true,
  region: false,
  autoStop: true,
};

async function loadE2bSdk(apiKey: string): Promise<E2bSandboxConstructor> {
  try {
    const mod = await import("e2b");
    const Sandbox = (mod as { Sandbox?: E2bSandboxConstructor }).Sandbox;
    if (!Sandbox) {
      throw new SandboxProviderError({
        providerKind: "e2b",
        operation: "loadSdk",
        detail: "e2b did not export a Sandbox client.",
      });
    }
    // E2B reads the key from E2B_API_KEY; we inject it for the lazy import.
    process.env.E2B_API_KEY = apiKey;
    return Sandbox;
  } catch (cause) {
    throw new SandboxProviderError({
      providerKind: "e2b",
      operation: "loadSdk",
      detail: "The e2b package is not installed. Install it to use the E2B sandbox provider.",
      cause: cause as never,
    });
  }
}

interface E2bSandboxConstructor {
  create: (input?: unknown) => Promise<E2bSandboxLike>;
  connect: (sandboxId: string, opts?: unknown) => Promise<E2bSandboxLike>;
  kill: (sandboxId: string, opts?: unknown) => Promise<void>;
}

interface E2bSandboxLike {
  sandboxId: string;
  getInfo?: () => Promise<{ state?: string }>;
  pause?: (opts?: unknown) => Promise<void>;
  kill?: (opts?: unknown) => Promise<void>;
  commands?: { run: (command: string, opts?: unknown) => Promise<{ stdout?: string }> };
}

const toSandboxState = (raw: string | undefined): CloudSandbox["state"] => {
  switch ((raw ?? "").toLowerCase()) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "killed":
    case "dead":
      return "deleted";
    default:
      return "running";
  }
};

const toCloudSandbox = (sandbox: E2bSandboxLike, state?: string): CloudSandbox => ({
  sandboxId: sandbox.sandboxId,
  providerKind: "e2b",
  label: sandbox.sandboxId,
  state: toSandboxState(state),
  createdAt: new Date().toISOString(),
});

export interface E2bAdapterDeps {
  readonly credentialKey: string;
  readonly getApiKey: () => Effect.Effect<string, SandboxProviderError>;
}

export const makeE2bAdapter = (deps: E2bAdapterDeps): SandboxProviderAdapter => {
  const runOp = Effect.fn("E2bAdapter.runOp")(function* <A>(
    op: string,
    use: (Sandbox: E2bSandboxConstructor) => Promise<A>,
  ) {
    const apiKey = yield* deps.getApiKey();
    const Sandbox = yield* Effect.tryPromise({
      try: () => loadE2bSdk(apiKey),
      catch: (cause) =>
        new SandboxProviderError({
          providerKind: "e2b",
          operation: "loadSdk",
          detail:
            (cause as SandboxProviderError)?.detail ??
            "The e2b package is not installed. Install it to use the E2B sandbox provider.",
          cause: cause as never,
        }),
    });
    return yield* Effect.tryPromise({
      try: () => use(Sandbox),
      catch: (cause) =>
        new SandboxProviderError({
          providerKind: "e2b",
          operation: op,
          detail: "E2B SDK call failed.",
          cause: cause as never,
        }),
    });
  });

  const fetchInfo = (sandbox: E2bSandboxLike): Effect.Effect<Option.Option<string>> =>
    Effect.tryPromise({
      try: () => (sandbox.getInfo ? sandbox.getInfo().then((i) => i.state) : Promise.resolve(undefined)),
      catch: () => undefined as never,
    }).pipe(
      Effect.map((state) => (state == null ? Option.none() : Option.some(state))),
      Effect.orElseSucceed(() => Option.none()),
    );

  return {
    kind: "e2b",
    capabilities: e2bCapabilities,

    validateConnection: () =>
      Effect.gen(function* () {
        const ok = yield* runOp("validateConnection", async () => true).pipe(
          Effect.match({ onFailure: () => false, onSuccess: () => true }),
        );
        return { ok, detail: ok ? null : "Could not initialize the E2B SDK with the stored key." } satisfies SandboxProviderValidationResult;
      }),

    createSandbox: (input: SandboxProviderProvisionInput) =>
      Effect.gen(function* () {
        const sandbox = yield* runOp("createSandbox", async (Sandbox) =>
          Sandbox.create({
            ...(input.options?.autoStopSeconds
              ? { defaultTimeoutMs: input.options.autoStopSeconds * 1000 }
              : {}),
          }),
        );
        const stateOpt = yield* fetchInfo(sandbox);
        return toCloudSandbox(sandbox, Option.getOrUndefined(stateOpt));
      }),

    reconnectSandbox: (sandboxId: string) =>
      Effect.gen(function* () {
        const sandbox = yield* runOp("reconnectSandbox", async (Sandbox) => Sandbox.connect(sandboxId));
        const stateOpt = yield* fetchInfo(sandbox);
        return toCloudSandbox(sandbox, Option.getOrUndefined(stateOpt));
      }),

    getSandbox: (sandboxId: string) =>
      Effect.gen(function* () {
        const sandbox = yield* runOp("getSandbox", async (Sandbox) => Sandbox.connect(sandboxId));
        const stateOpt = yield* fetchInfo(sandbox);
        return toCloudSandbox(sandbox, Option.getOrUndefined(stateOpt));
      }),

    startSandbox: () =>
      Effect.fail(
        new SandboxProviderError({
          providerKind: "e2b",
          operation: "start",
          detail: "E2B does not support a separate start; use resume to reconnect a paused sandbox.",
        }),
      ),

    stopSandbox: (sandboxId: string) =>
      Effect.gen(function* () {
        yield* runOp("stopSandbox", async (Sandbox) => Sandbox.kill(sandboxId));
        return {
          sandboxId,
          providerKind: "e2b",
          label: sandboxId,
          state: "deleted",
          createdAt: new Date().toISOString(),
        } satisfies CloudSandbox;
      }),

    pauseSandbox: (sandboxId: string) =>
      Effect.gen(function* () {
        const sandbox = yield* runOp("pauseSandbox", async (Sandbox) => Sandbox.connect(sandboxId));
        yield* Effect.tryPromise({
          try: () => sandbox.pause?.() ?? Promise.resolve(),
          catch: (cause) =>
            new SandboxProviderError({
              providerKind: "e2b",
              operation: "pauseSandbox",
              detail: "Could not pause the E2B sandbox.",
              cause: cause as never,
            }),
        });
        return toCloudSandbox(sandbox, "paused");
      }),

    resumeSandbox: (sandboxId: string) =>
      Effect.gen(function* () {
        const sandbox = yield* runOp("resumeSandbox", async (Sandbox) => Sandbox.connect(sandboxId));
        const stateOpt = yield* fetchInfo(sandbox);
        return toCloudSandbox(sandbox, Option.getOrUndefined(stateOpt) ?? "running");
      }),

    deleteSandbox: (sandboxId: string) =>
      Effect.gen(function* () {
        yield* runOp("deleteSandbox", async (Sandbox) => Sandbox.kill(sandboxId));
      }),

    resolveConnectionTarget: (sandboxId: string) =>
      // E2B is driven through its SDK over HTTP/WebSocket; there is no SSH. The
      // cloud execution environment layer uses the SDK commands/filesystem APIs to
      // bootstrap and drive the T3 backend inside the sandbox.
      Effect.succeed({
        sandboxId,
        transport: "http",
      } satisfies SandboxConnectionTarget),
  };
};
