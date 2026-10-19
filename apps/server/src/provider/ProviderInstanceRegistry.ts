import {
  providerInstanceConfigEnabledFlag,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Option from "effect/Option";
import * as CloudRuntimeService from "@t3tools/cloud-runtime/CloudRuntimeService";
import * as Stream from "effect/Stream";

import { buildUnavailableProviderSnapshot } from "./unavailableProviderSnapshot.ts";
import * as ProviderInstanceRegistryMutator from "./ProviderInstanceRegistryMutator.ts";
import type { CloudRuntimeServiceShape } from "@t3tools/cloud-runtime/CloudRuntimeService";
import type { AnyProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";

export class ProviderInstanceRegistry extends Context.Service<
  ProviderInstanceRegistry,
  {
    readonly getInstance: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<ProviderInstance | undefined>;
    readonly listInstances: Effect.Effect<ReadonlyArray<ProviderInstance>>;
    readonly listUnavailable: Effect.Effect<ReadonlyArray<ServerProvider>>;
    /**
     * NOTE: because `Stream.fromPubSub` defers `PubSub.subscribe` until the stream starts
     * running, forking a consumer via `Stream.runForEach(...).pipe(Effect.forkScoped)` races
     * the next publish — the forked fiber may not have subscribed yet when the publish lands.
     * Hot-reload consumers that must not miss a publish should use `subscribeChanges` below
     * instead, which acquires the subscription synchronously in the caller's fiber before the
     * consumer loop is forked.
     */
    readonly streamChanges: Stream.Stream<void>;
    readonly subscribeChanges: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
  }
>()("t3/provider/ProviderInstanceRegistry") {}

interface LiveEntry {
  readonly instance: ProviderInstance;
  readonly scope: Scope.Closeable;
  readonly entry: ProviderInstanceConfig;
}

interface RegistryState {
  readonly entries: Ref.Ref<ReadonlyMap<ProviderInstanceId, LiveEntry>>;
  readonly unavailable: Ref.Ref<ReadonlyMap<ProviderInstanceId, ServerProvider>>;
  readonly changes: PubSub.PubSub<void>;
}

const entryEqual = (a: ProviderInstanceConfig, b: ProviderInstanceConfig): boolean =>
  Equal.equals(a, b);

/**
 * How strongly an entry's configuration asks to be the live one.
 *
 * An explicit `false` on either the envelope or the raw config blob is the
 * user's decision and wins (most restrictive); an explicit `true` on either is
 * an unambiguous opt-in. Anything else is unspecified, and which side of the
 * line it falls on depends on the driver's own schema default — not yet
 * decoded at the point a single-instance driver has to pick a survivor.
 */
const singleInstanceEntryRank = (entry: ProviderInstanceConfig): number => {
  const configEnabled = providerInstanceConfigEnabledFlag(entry.config);
  if (entry.enabled === false || configEnabled === false) return 2;
  if (entry.enabled === true || configEnabled === true) return 0;
  return 1;
};

/**
 * Resolve an entry's enabled state. An explicit false on either the
 * envelope or the raw config blob wins (most restrictive) — old settings
 * files can carry both flags with conflicting values, and a user's disable
 * must never be silently undone. Otherwise the envelope flag wins, then the
 * decoded config's flag (which carries the driver schema's default for
 * built-ins and forks alike), then enabled by default.
 */
const resolveEntryEnabled = (entry: ProviderInstanceConfig, typedConfig: unknown): boolean => {
  const rawConfigEnabled = providerInstanceConfigEnabledFlag(entry.config);
  if (entry.enabled === false || rawConfigEnabled === false) {
    return false;
  }
  return entry.enabled ?? providerInstanceConfigEnabledFlag(typedConfig) ?? true;
};

const buildEntry = <R>(input: {
  readonly driversById: ReadonlyMap<ProviderDriverKind, AnyProviderDriver<R>>;
  /** Present only where the server runs a cloud runtime. */
  readonly cloudRuntime: Option.Option<CloudRuntimeServiceShape>;
  readonly parentScope: Scope.Scope;
  readonly instanceId: ProviderInstanceId;
  readonly rawInstanceId: string;
  readonly entry: ProviderInstanceConfig;
}): Effect.Effect<
  | { readonly kind: "live"; readonly live: LiveEntry }
  | { readonly kind: "unavailable"; readonly snapshot: ServerProvider },
  never,
  R
> =>
  Effect.gen(function* () {
    const { driversById, parentScope, instanceId, rawInstanceId, entry, cloudRuntime } = input;
    const driver = driversById.get(entry.driver);
    if (!driver) {
      return {
        kind: "unavailable" as const,
        snapshot: yield* buildUnavailableProviderSnapshot({
          driverKind: entry.driver,
          instanceId,
          displayName: entry.displayName,
          accentColor: entry.accentColor,
          reason: `Driver '${entry.driver}' is not registered in this build.`,
        }),
      };
    }

    const decoder = Schema.decodeUnknownEffect(driver.configSchema);
    const decodeResult = yield* decoder(entry.config ?? driver.defaultConfig()).pipe(Effect.result);
    if (decodeResult._tag === "Failure") {
      const issue = decodeResult.failure;
      const detail = issue.message ?? String(issue);
      yield* Effect.logError("Failed to decode provider instance config", {
        instanceId: rawInstanceId,
        driver: entry.driver,
        detail,
      });
      return {
        kind: "unavailable" as const,
        snapshot: yield* buildUnavailableProviderSnapshot({
          driverKind: entry.driver,
          instanceId,
          displayName: entry.displayName,
          accentColor: entry.accentColor,
          reason: `Invalid config for instance '${rawInstanceId}': ${detail}`,
        }),
      };
    }

    const typedConfig = decodeResult.success;
    if (
      entry.executionTarget?.enabled === true &&
      driver.metadata.supportsCloudExecution !== true
    ) {
      return {
        kind: "unavailable" as const,
        snapshot: yield* buildUnavailableProviderSnapshot({
          driverKind: entry.driver,
          instanceId,
          displayName: entry.displayName,
          accentColor: entry.accentColor,
          reason: `Driver '${entry.driver}' does not support cloud execution.`,
        }),
      };
    }
    const childScope = yield* Scope.make();
    yield* Scope.addFinalizer(parentScope, Scope.close(childScope, Exit.void).pipe(Effect.ignore));

    const createResult = yield* driver
      .create({
        instanceId,
        displayName: entry.displayName,
        accentColor: entry.accentColor,
        environment: entry.environment ?? [],
        ...(entry.executionTarget ? { executionTarget: entry.executionTarget } : {}),
        ...(Option.isNone(cloudRuntime) ? {} : { cloudRuntime: cloudRuntime.value }),
        enabled: resolveEntryEnabled(entry, typedConfig),
        config: typedConfig,
      })
      .pipe(Effect.provideService(Scope.Scope, childScope), Effect.result);
    if (createResult._tag === "Failure") {
      yield* Effect.logError("Failed to create provider instance", {
        instanceId: rawInstanceId,
        driver: entry.driver,
        detail: createResult.failure.detail,
      });
      yield* Scope.close(childScope, Exit.void).pipe(Effect.ignore);
      return {
        kind: "unavailable" as const,
        snapshot: yield* buildUnavailableProviderSnapshot({
          driverKind: entry.driver,
          instanceId,
          displayName: entry.displayName,
          accentColor: entry.accentColor,
          reason: `Driver '${entry.driver}' failed to create instance: ${createResult.failure.detail}`,
        }),
      };
    }

    return {
      kind: "live" as const,
      live: {
        instance: createResult.success,
        scope: childScope,
        entry,
      },
    };
  });

const makeReconcile = <R>(input: {
  readonly state: RegistryState;
  readonly driversById: ReadonlyMap<ProviderDriverKind, AnyProviderDriver<R>>;
  readonly parentScope: Scope.Scope;
  /** Present only where the server runs a cloud runtime. */
  readonly cloudRuntime: Option.Option<CloudRuntimeServiceShape>;
}): ((configMap: ProviderInstanceConfigMap) => Effect.Effect<void, never, R>) => {
  const { state, driversById, parentScope, cloudRuntime } = input;
  return (configMap: ProviderInstanceConfigMap) =>
    Effect.gen(function* () {
      const previousEntries = yield* Ref.get(state.entries);
      const previousUnavailable = yield* Ref.get(state.unavailable);
      const nextRaw = Object.entries(configMap);
      const nextKeys = new Set<ProviderInstanceId>(
        nextRaw.map(([raw]) => ProviderInstanceId.make(raw)),
      );
      const singleInstanceCandidates = new Map<
        ProviderDriverKind,
        Array<{ readonly instanceId: ProviderInstanceId; readonly rank: number }>
      >();
      const blockedMultipleInstanceIds = new Set<ProviderInstanceId>();
      for (const [rawInstanceId, entry] of nextRaw) {
        const driver = driversById.get(entry.driver);
        if (driver?.metadata.supportsMultipleInstances !== false) continue;
        const candidates = singleInstanceCandidates.get(entry.driver) ?? [];
        candidates.push({
          instanceId: ProviderInstanceId.make(rawInstanceId),
          rank: singleInstanceEntryRank(entry),
        });
        singleInstanceCandidates.set(entry.driver, candidates);
      }
      for (const [driver, candidates] of singleInstanceCandidates) {
        // Ranked rather than filtered on `enabled`, because this runs before
        // any driver config has been decoded and so cannot know whether an
        // omitted flag means enabled or disabled. "Explicitly on" wins over
        // "unspecified", which wins over "explicitly off", and the tie-break is
        // the instance id: taking the first settings key would swap the live
        // instance — and kill its session — whenever the file is rewritten in a
        // different order.
        const kept = [...candidates].sort(
          (left, right) =>
            left.rank - right.rank || left.instanceId.localeCompare(right.instanceId),
        )[0];
        if (!kept) continue;
        for (const candidate of candidates) {
          if (candidate.instanceId === kept.instanceId) continue;
          blockedMultipleInstanceIds.add(candidate.instanceId);
          yield* Effect.logWarning("Provider driver does not support multiple instances", {
            driver,
            instanceId: candidate.instanceId,
            keptInstanceId: kept.instanceId,
          });
        }
      }

      // 1. Close scopes for instances that disappeared or whose config
      //    changed. Do this BEFORE creating replacements so ids map 1-to-1
      //    to live scopes at all times.
      const removedIds: Array<ProviderInstanceId> = [];
      const replacedIds = new Set<ProviderInstanceId>();
      for (const [instanceId, live] of previousEntries) {
        if (!nextKeys.has(instanceId)) {
          removedIds.push(instanceId);
          continue;
        }
        if (blockedMultipleInstanceIds.has(instanceId)) {
          replacedIds.add(instanceId);
          continue;
        }
        const nextEntry = configMap[instanceId];
        if (nextEntry !== undefined && !entryEqual(live.entry, nextEntry)) {
          replacedIds.add(instanceId);
        }
      }
      for (const id of [...removedIds, ...replacedIds]) {
        const live = previousEntries.get(id);
        if (live) {
          yield* Scope.close(live.scope, Exit.void).pipe(Effect.ignore);
        }
      }

      const builtEntries = new Map<ProviderInstanceId, LiveEntry>();
      const builtUnavailable = new Map<ProviderInstanceId, ServerProvider>();
      let orderChanged = false;
      const previousOrder = [...previousEntries.keys()];
      const nextOrder: Array<ProviderInstanceId> = [];

      for (const [rawInstanceId, entry] of nextRaw) {
        const instanceId = ProviderInstanceId.make(rawInstanceId);

        if (blockedMultipleInstanceIds.has(instanceId)) {
          builtUnavailable.set(
            instanceId,
            yield* buildUnavailableProviderSnapshot({
              driverKind: entry.driver,
              instanceId,
              displayName: entry.displayName,
              accentColor: entry.accentColor,
              reason: `Driver '${entry.driver}' supports only one configured instance.`,
            }),
          );
          continue;
        }

        const existing = previousEntries.get(instanceId);
        if (existing !== undefined && !replacedIds.has(instanceId)) {
          builtEntries.set(instanceId, existing);
          continue;
        }

        const result = yield* buildEntry({
          driversById,
          parentScope,
          instanceId,
          rawInstanceId,
          entry,
          cloudRuntime,
        });
        if (result.kind === "live") {
          builtEntries.set(instanceId, result.live);
        } else {
          builtUnavailable.set(instanceId, result.snapshot);
        }
      }

      nextOrder.push(...builtEntries.keys());

      if (previousOrder.length === nextOrder.length) {
        for (let i = 0; i < previousOrder.length; i++) {
          if (previousOrder[i] !== nextOrder[i]) {
            orderChanged = true;
            break;
          }
        }
      } else {
        orderChanged = true;
      }

      const entriesChanged =
        orderChanged ||
        removedIds.length > 0 ||
        replacedIds.size > 0 ||
        builtEntries.size !== previousEntries.size;
      const unavailableChanged =
        builtUnavailable.size !== previousUnavailable.size ||
        [...builtUnavailable].some(([id, snapshot]) => {
          const prev = previousUnavailable.get(id);
          return prev === undefined || !Equal.equals(prev, snapshot);
        }) ||
        [...previousUnavailable].some(([id]) => !builtUnavailable.has(id));

      yield* Ref.set(state.entries, builtEntries);
      yield* Ref.set(state.unavailable, builtUnavailable);

      if (entriesChanged || unavailableChanged) {
        yield* PubSub.publish(state.changes, undefined);
      }
    });
};

export const makeProviderInstanceRegistry = <R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
}): Effect.Effect<
  {
    readonly registry: ProviderInstanceRegistry["Service"];
    readonly mutator: ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutatorShape;
  },
  never,
  R | Scope.Scope
> =>
  Effect.gen(function* () {
    const driversById = new Map<ProviderDriverKind, AnyProviderDriver<R>>(
      input.drivers.map((driver) => [driver.driverKind, driver]),
    );

    // Capture the enclosing scope so per-instance child scopes can be
    // attached to it at `reconcile` time. Without this, `reconcile`
    // called later (e.g. from the hydration layer) would attach child
    // scopes to the *caller's* scope instead of the registry's.
    const parentScope = yield* Scope.Scope;

    const driverContext = yield* Effect.context<R>();
    // A deployment without a cloud runtime still boots every local instance:
    // the service is resolved once, here, instead of by each driver.
    const cloudRuntime = yield* Effect.serviceOption(CloudRuntimeService.CloudRuntimeService);

    const entries = yield* Ref.make<ReadonlyMap<ProviderInstanceId, LiveEntry>>(new Map());
    const unavailable = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ServerProvider>>(new Map());
    const changes = yield* PubSub.unbounded<void>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(changes));

    const state: RegistryState = { entries, unavailable, changes };
    const reconcileWithR = makeReconcile({
      state,
      driversById,
      parentScope,
      cloudRuntime,
    });
    const reconcile: ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutatorShape["reconcile"] =
      (configMap) => reconcileWithR(configMap).pipe(Effect.provideContext(driverContext));

    yield* reconcile(input.configMap);

    const registry: ProviderInstanceRegistry["Service"] = {
      getInstance: (id) => Ref.get(entries).pipe(Effect.map((map) => map.get(id)?.instance)),
      listInstances: Ref.get(entries).pipe(
        Effect.map(
          (map) =>
            Array.from(map.values(), (live) => live.instance) as ReadonlyArray<ProviderInstance>,
        ),
      ),
      listUnavailable: Ref.get(unavailable).pipe(
        Effect.map((map) => Array.from(map.values()) as ReadonlyArray<ServerProvider>),
      ),
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
      get subscribeChanges() {
        return PubSub.subscribe(changes);
      },
    };

    const mutator: ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutatorShape = {
      reconcile,
    };

    return { registry, mutator };
  });

export const layer = <R>(input: {
  readonly drivers: ReadonlyArray<AnyProviderDriver<R>>;
  readonly configMap: ProviderInstanceConfigMap;
}): Layer.Layer<
  ProviderInstanceRegistry | ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
  never,
  R
> =>
  Layer.effectContext(
    makeProviderInstanceRegistry(input).pipe(
      Effect.map(({ registry, mutator }) =>
        Context.make(ProviderInstanceRegistry, registry).pipe(
          Context.add(ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator, mutator),
        ),
      ),
    ),
  ) as Layer.Layer<
    ProviderInstanceRegistry | ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
    never,
    R
  >;
