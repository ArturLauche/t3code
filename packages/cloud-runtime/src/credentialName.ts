import { CloudRuntimeId, type CloudRuntimeConfig, type ServerSettings } from "@t3tools/contracts";

/** Stable secret-store key for a cloud runtime credential. */
export const cloudRuntimeCredentialName = (runtimeId: CloudRuntimeId): string =>
  `cloud-runtime-${Buffer.from(runtimeId, "utf8").toString("base64url")}`;

/**
 * Whether a stored credential still serves the same runtime. Vendor, endpoint,
 * and region are part of its scope; any change would leak the old account's key.
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
 * Runtime ids whose credential stopped matching between settings snapshots,
 * whether removed or repointed, so the old key is not sent to the new vendor.
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
