/**
 * Retires cloud sandboxes whose runtime stopped pointing at the account that
 * created them.
 *
 * Deleting a runtime, or repointing one at another vendor, endpoint or region,
 * moves the runtime somewhere its stored credential no longer works. The
 * sandboxes created under the previous identity keep billing and become
 * unreachable from T3: the adapter can only list the new account, and the
 * credential that owned them is removed by the settings layer on the same
 * transition. Watching that transition here — with the previous identity
 * still in hand — is the only point where they can still be deleted.
 */
import {
  CloudRuntimeId,
  type CloudRuntimeConfig,
  type CloudSandboxSummary,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { cloudRuntimeCredentialName, staleCloudCredentialIds } from "./credentialName.ts";
import { isManagedSandbox } from "./sandboxOwnership.ts";
import { makeCloudVendorAdapter, type CloudVendorAdapter } from "./VendorAdapter.ts";

const decoder = new TextDecoder();

/** Runtime configurations this process has seen, keyed by runtime id. */
export type CloudRuntimeConfigs = Readonly<Record<string, CloudRuntimeConfig>>;

export interface CloudSandboxRetirementDependencies {
  readonly environmentId: string;
  readonly readCredential: (runtimeId: CloudRuntimeId) => Effect.Effect<string>;
  readonly makeVendor: (input: {
    readonly runtimeId: CloudRuntimeId;
    readonly config: CloudRuntimeConfig;
    readonly apiKey: string;
    readonly environmentId: string;
  }) => CloudVendorAdapter;
}

const deleteSandboxes = (
  runtimeId: CloudRuntimeId,
  vendor: CloudVendorAdapter,
  environmentId: string,
) =>
  Effect.gen(function* () {
    const sandboxes: ReadonlyArray<CloudSandboxSummary> = yield* Effect.promise(() =>
      vendor.listSandboxes(),
    );
    for (const sandbox of sandboxes) {
      if (!isManagedSandbox(sandbox, runtimeId, environmentId)) continue;
      // A vendor rejection is a defect here, not a typed failure: it must not
      // stop the remaining sandboxes from being retired.
      yield* Effect.promise(() => vendor.action(sandbox.sandboxId, "delete")).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Failed to retire a cloud sandbox whose runtime was repointed.", {
            runtimeId,
            sandboxId: sandbox.sandboxId,
            cause,
          }),
        ),
      );
    }
  }).pipe(
    Effect.ensuring(
      vendor.close ? Effect.promise(() => vendor.close!()).pipe(Effect.ignore) : Effect.void,
    ),
  );

/**
 * Deletes the sandboxes of every runtime that disappeared or was repointed
 * between two settings snapshots.
 *
 * Best effort by design: a vendor that cannot be reached must not stall the
 * settings stream, so failures are reported per runtime and the rest continue.
 */
export const retireCloudRuntimes = Effect.fnUntraced(function* (
  previous: CloudRuntimeConfigs,
  next: CloudRuntimeConfigs,
  dependencies: CloudSandboxRetirementDependencies,
) {
  const { environmentId, readCredential, makeVendor } = dependencies;
  for (const runtimeId of staleCloudCredentialIds(previous, next)) {
    const apiKey = yield* readCredential(runtimeId);
    if (!apiKey) continue;
    yield* Effect.logWarning("Retiring cloud sandboxes left by a removed or repointed runtime.", {
      runtimeId,
      kind: previous[runtimeId]?.kind,
    });
    yield* Effect.try({
      try: () => makeVendor({ runtimeId, config: previous[runtimeId]!, apiKey, environmentId }),
      catch: (cause) => new Cause.UnknownError(cause, "cloud vendor client"),
    }).pipe(
      Effect.flatMap((vendor) => deleteSandboxes(runtimeId, vendor, environmentId)),
      Effect.catchCause((cause) =>
        Effect.logError("Failed to reach a removed cloud runtime to retire its sandboxes.", {
          runtimeId,
          cause,
        }),
      ),
    );
  }
});

const makeCloudSandboxRetirement = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironmentIdentity)
    .getEnvironmentId;
  const scope = yield* Scope.Scope;

  const readCredential = (runtimeId: CloudRuntimeId) =>
    secretStore.get(cloudRuntimeCredentialName(runtimeId)).pipe(
      Effect.map((value) =>
        Option.match(value, {
          onNone: () => "",
          onSome: (bytes) => decoder.decode(bytes),
        }),
      ),
      Effect.orElseSucceed(() => ""),
    );

  // Seeded from the current settings so a restart never mistakes its own
  // first snapshot for a change.
  const known = yield* Ref.make<CloudRuntimeConfigs>(
    yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.cloudRuntimeInstances),
      Effect.orElseSucceed(() => ({})),
    ),
  );

  yield* Effect.forkIn(scope)(
    Stream.runForEach(yield* serverSettings.subscribeChanges, (settings: ServerSettings) =>
      Effect.gen(function* () {
        const previous: CloudRuntimeConfigs = yield* Ref.get(known);
        const next = settings.cloudRuntimeInstances;
        yield* Ref.set(known, next);
        yield* retireCloudRuntimes(previous, next, {
          environmentId,
          readCredential,
          makeVendor: makeCloudVendorAdapter,
        });
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Cloud sandbox retirement stopped.", { cause }),
      ),
    ),
  );
});

export const CloudSandboxRetirementLive: Layer.Layer<
  never,
  never,
  | ServerEnvironment.ServerEnvironmentIdentity
  | ServerSecretStore.ServerSecretStore
  | ServerSettingsService
> = Layer.effectDiscard(makeCloudSandboxRetirement);
