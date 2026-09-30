import { CloudRuntimeId, type CloudRuntimeConfig, type ServerSettings } from "@t3tools/contracts";

/** Stable secret-store key for a cloud runtime credential. */
export const cloudRuntimeCredentialName = (runtimeId: CloudRuntimeId): string =>
  `cloud-runtime-${Buffer.from(runtimeId, "utf8").toString("base64url")}`;

/**
 * Whether one stored credential may keep serving the same runtime.
 *
 * The credential belongs to one vendor account at one endpoint, so the vendor
 * kind, the API domain, any custom endpoint and the region are all part of its
 * scope. Changing any of them points the runtime at a different destination,
 * and sending the previous account's key there would leak it.
 */
export const sameCloudCredentialScope = (
  previous: CloudRuntimeConfig,
  next: CloudRuntimeConfig,
): boolean =>
  previous.kind === next.kind &&
  (previous.domain ?? null) === (next.domain ?? null) &&
  (previous.apiUrl ?? null) === (next.apiUrl ?? null) &&
  (previous.region ?? null) === (next.region ?? null);

/**
 * Runtime ids whose stored credential stopped belonging to them between two
 * settings snapshots.
 *
 * Both a removed runtime and a repointed one are stale for the same reason: the
 * key either has no configuration left, or its configuration now names a
 * different account. Settings reaches this through the update transaction and
 * through hand edits of `settings.json`, and both have to agree, or a reload
 * would leave the previous vendor's key in the store and ready to be sent to
 * the new one.
 */
export const staleCloudCredentialIds = (
  previous: ServerSettings["cloudRuntimeInstances"],
  next: ServerSettings["cloudRuntimeInstances"],
): ReadonlyArray<CloudRuntimeId> =>
  Object.entries(previous).flatMap(([runtimeId, previousConfig]) => {
    const id = CloudRuntimeId.make(runtimeId);
    const nextConfig = next[id];
    if (nextConfig && sameCloudCredentialScope(previousConfig, nextConfig)) return [];
    return [id];
  });
