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
 * Novita AI Agent Sandbox provider adapter.
 *
 * Novita exposes a TypeScript SDK (`novita-sandbox`) with code-interpreter,
 * filesystem, command and lifecycle APIs. Like E2B, Novita sandboxes do not
 * expose SSH; they are driven through the SDK over HTTP. Pause/resume preserve
 * full memory + filesystem state; kill permanently deletes. The adapter
 * therefore mirrors the E2B transport model rather than pretending SSH exists.
 *
 * The SDK is loaded lazily so `novita-sandbox` is an optional peer dependency.
 */
const novitaCapabilities: SandboxLifecycleCapabilities = {
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

async function loadNovitaSdk(apiKey: string): Promise<NovitaSandboxConstructor> {
  try {
    const mod = await import("novita-sandbox/code-interpreter");
    const Sandbox = (mod as { Sandbox?: NovitaSandboxConstructor }).Sandbox;
    if (!Sandbox) {
      throw new SandboxProviderError({
        providerKind: "novita",
        operation: "loadSdk",
        detail: "novita-sandbox did not export a Sandbox client.",
      });
    }
    process.env.NOVITA_API_KEY = apiKey;
    return Sandbox;
  } catch (cause) {
    throw new SandboxProviderError({
      providerKind: "novita",
      operation: "loadSdk",
      detail: "The novita-sandbox package is not installed. Install it to use the Novita sandbox provider.",
      cause: cause as never,
    });
  }
}

interface NovitaSandboxConstructor {
  create: (input?: unknown) => Promise<NovitaSandboxLike>;
  connect: (sandboxId: string, opts?: unknown) => Promise<NovitaSandboxLike>;
  kill: (sandboxId: string, opts?: unknown) => Promise<void>;
}

interface NovitaSandboxLike {
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

const toCloudSandbox = (sandbox: NovitaSandboxLike, state?: string): CloudSandbox => ({
  sandboxId: sandbox.sandboxId,
  providerKind: "novita",
  label: sandbox.sandboxId,
  state: toSandboxState(state),
  createdAt: new Date().toISOString(),
});

export interface NovitaAdapterDeps {
  readonly credentialKey: string;
  readonly getApiKey: () => Effect.Effect<string, SandboxProviderError>;
}

export const makeNovitaAdapter = (deps: NovitaAdapterDeps): SandboxProviderAdapter => {
  const runOp = Effect.fn("NovitaAdapter.runOp")(function* <A>(
    op: string,
    use: (Sandbox: NovitaSandboxConstructor) => Promise<A>,
  ) {
    const apiKey = yield* deps.getApiKey();
    const Sandbox = yield* Effect.tryPromise({
      try: () => loadNovitaSdk(apiKey),
      catch: (cause) =>
        new SandboxProviderError({
          providerKind: "novita",
          operation: "loadSdk",
          detail:
            (cause as SandboxProviderError)?.detail ??
            "The novita-sandbox package is not installed. Install it to use the Novita sandbox provider.",
          cause: cause as never,
        }),
    });
    return yield* Effect.tryPromise({
      try: () => use(Sandbox),
      catch: (cause) =>
        new SandboxProviderError({
          providerKind: "novita",
          operation: op,
          detail: "Novita SDK call failed.",
          cause: cause as never,
        }),
    });
  });

  const fetchInfo = (sandbox: NovitaSandboxLike): Effect.Effect<Option.Option<string>> =>
    Effect.tryPromise({
      try: () => (sandbox.getInfo ? sandbox.getInfo().then((i) => i.state) : Promise.resolve(undefined)),
      catch: () => undefined as never,
    }).pipe(
      Effect.map((state) => (state == null ? Option.none() : Option.some(state))),
      Effect.orElseSucceed(() => Option.none()),
    );

  return {
    kind: "novita",
    capabilities: novitaCapabilities,

    validateConnection: () =>
      Effect.gen(function* () {
        const ok = yield* runOp("validateConnection", async () => true).pipe(
          Effect.match({ onFailure: () => false, onSuccess: () => true }),
        );
        return { ok, detail: ok ? null : "Could not initialize the Novita SDK with the stored key." } satisfies SandboxProviderValidationResult;
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
          providerKind: "novita",
          operation: "start",
          detail: "Novita does not support a separate start; use resume to reconnect a paused sandbox.",
        }),
      ),

    stopSandbox: (sandboxId: string) =>
      Effect.gen(function* () {
        yield* runOp("stopSandbox", async (Sandbox) => Sandbox.kill(sandboxId));
        return {
          sandboxId,
          providerKind: "novita",
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
              providerKind: "novita",
              operation: "pauseSandbox",
              detail: "Could not pause the Novita sandbox.",
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
      // Novita is driven through its SDK over HTTP; no SSH. Same transport model as E2B.
      Effect.succeed({
        sandboxId,
        transport: "http",
      } satisfies SandboxConnectionTarget),
  };
};
