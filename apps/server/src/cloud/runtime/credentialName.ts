import type { CloudRuntimeId } from "@t3tools/contracts";

/** Stable secret-store key for a cloud runtime credential. */
export const cloudRuntimeCredentialName = (runtimeId: CloudRuntimeId): string =>
  `cloud-runtime-${Buffer.from(runtimeId, "utf8").toString("base64url")}`;
