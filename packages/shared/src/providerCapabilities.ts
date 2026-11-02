/**
 * Provider capability gating shared by web and mobile. The server declares
 * limits on `ServerProvider`; clients ask these helpers instead of branching on
 * driver names.
 */
import type { ProviderInteractionMode, RuntimeMode, ServerProvider } from "@t3tools/contracts";

/** The subset of a provider snapshot the gating rules read. */
export type ProviderCapabilitySnapshot = Pick<
  ServerProvider,
  | "displayName"
  | "driver"
  | "supportedRuntimeModes"
  | "showInteractionModeToggle"
  | "supportsImageAttachments"
  | "supportsFileAttachments"
>;

/** The narrowest shape the mode helpers need, for callers holding only a list. */
export type RuntimeModeCapabilitySnapshot = Pick<
  ProviderCapabilitySnapshot,
  "supportedRuntimeModes"
>;

/**
 * Every access mode in picker order. `AssertNever` below fails compilation when
 * a contract mode is added without listing it here.
 */
const RUNTIME_MODE_ORDER = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;
type AssertNever<T extends never> = T;
type _AllRuntimeModesListed = AssertNever<
  Exclude<RuntimeMode, (typeof RUNTIME_MODE_ORDER)[number]>
>;

export const ALL_RUNTIME_MODES: ReadonlyArray<RuntimeMode> = RUNTIME_MODE_ORDER;

export const RUNTIME_MODE_LABELS: Readonly<Record<RuntimeMode, string>> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

function providerLabel(provider: ProviderCapabilitySnapshot | null | undefined): string {
  return provider?.displayName?.trim() || "This provider";
}

/**
 * Access modes the provider can enforce. An absent list means "all of them",
 * which stays true for every provider that has not declared a narrower set.
 */
export function getProviderSupportedRuntimeModes(
  provider: RuntimeModeCapabilitySnapshot | null | undefined,
): ReadonlyArray<RuntimeMode> {
  const declared = provider?.supportedRuntimeModes;
  return declared && declared.length > 0 ? declared : ALL_RUNTIME_MODES;
}

export function providerSupportsRuntimeMode(
  provider: RuntimeModeCapabilitySnapshot | null | undefined,
  runtimeMode: RuntimeMode,
): boolean {
  return getProviderSupportedRuntimeModes(provider).includes(runtimeMode);
}

/**
 * The tightest mode the provider can enforce. Deliberately narrow: widening the
 * grant to unblock a send defeats the warning.
 */
function narrowestRuntimeMode(supported: ReadonlyArray<RuntimeMode>): RuntimeMode | undefined {
  // `ALL_RUNTIME_MODES` runs narrowest-first, so the first supported entry is
  // the tightest one available.
  return ALL_RUNTIME_MODES.find((mode) => supported.includes(mode));
}

function unsupportedRuntimeModeReason(
  provider: ProviderCapabilitySnapshot,
  supported: ReadonlyArray<RuntimeMode>,
): string {
  const label = providerLabel(provider);
  const suggestion = narrowestRuntimeMode(supported);
  if (!suggestion) {
    return `${label} does not declare any supported access mode. Re-check the provider in Settings.`;
  }
  return `${label} does not support the selected access mode. Choose ${RUNTIME_MODE_LABELS[suggestion]} to continue.`;
}

function planUnsupportedReason(provider: ProviderCapabilitySnapshot): string {
  return `${providerLabel(provider)} does not support Plan mode. Choose Build to continue.`;
}

/**
 * The reason a turn cannot be sent as composed, or `null` when it can.
 * Access mode wins over Plan, which wins over attachments, so the message names
 * the first thing the user has to change.
 */
export function getUnsupportedProviderModeReason(input: {
  readonly provider: ProviderCapabilitySnapshot | null | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
}): string | null {
  const { provider, runtimeMode, interactionMode } = input;
  if (!provider) return null;
  // Never empty: an absent or empty declaration means "all of them". The
  // no-modes-declared case therefore cannot be reached here, and the composer
  // always has at least one access mode to steer toward.
  const supported = getProviderSupportedRuntimeModes(provider);
  if (!supported.includes(runtimeMode)) {
    return unsupportedRuntimeModeReason(provider, supported);
  }
  if (interactionMode === "plan" && provider.showInteractionModeToggle === false) {
    return planUnsupportedReason(provider);
  }
  return null;
}

export function providerSupportsImageAttachments(
  provider: ProviderCapabilitySnapshot | null | undefined,
): boolean {
  return provider?.supportsImageAttachments !== false;
}

/**
 * Files are a separate question from images: a provider can take a file and
 * still drop an image, so the two flags are never inferred from each other.
 */
export function providerSupportsFileAttachments(
  provider: ProviderCapabilitySnapshot | null | undefined,
): boolean {
  return provider?.supportsFileAttachments !== false;
}

/**
 * The reason the composed attachments cannot be sent, or `null`.
 *
 * Counts are separate so the message names what the user actually has to
 * remove. Reporting "images" for a file-only draft would send the user looking
 * for an image they never attached.
 */
export function getUnsupportedProviderAttachmentReason(input: {
  readonly provider: ProviderCapabilitySnapshot | null | undefined;
  readonly attachmentCount: number;
  readonly fileCount?: number;
}): string | null {
  const imageCount = Math.max(0, input.attachmentCount - (input.fileCount ?? 0));
  if (input.attachmentCount === 0) return null;
  const label = providerLabel(input.provider);
  const imagesUnsupported = imageCount > 0 && !providerSupportsImageAttachments(input.provider);
  const filesUnsupported =
    (input.fileCount ?? 0) > 0 && !providerSupportsFileAttachments(input.provider);
  if (imagesUnsupported && filesUnsupported) {
    return `${label} does not support attachments. Remove them to continue.`;
  }
  if (filesUnsupported) {
    return `${label} does not support file attachments. Remove the files to continue.`;
  }
  if (imagesUnsupported) {
    return `${label} does not support image attachments. Remove the images to continue.`;
  }
  return null;
}

export type UnsupportedProviderInputKind = "mode" | "attachment" | "unknown";

/** A queued turn that cannot be sent yet, and the state that explains it. */
export interface UnsupportedProviderInput {
  readonly kind: UnsupportedProviderInputKind;
  readonly reason: string;
}

/**
 * Single source for the send gate and banner copy. `capabilityUnknown` separates
 * an unloaded snapshot from a permissive provider; queue drains pass true.
 */
export function getUnsupportedProviderInputReason(input: {
  readonly provider: ProviderCapabilitySnapshot | null | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly attachmentCount: number;
  readonly fileCount?: number;
  readonly capabilityUnknown?: boolean;
}): UnsupportedProviderInput | null {
  if (input.capabilityUnknown === true) {
    return {
      kind: "unknown",
      reason:
        "Waiting for this environment's provider capabilities. Retry once the connection has settled.",
    };
  }
  const modeReason = getUnsupportedProviderModeReason(input);
  if (modeReason !== null) return { kind: "mode", reason: modeReason };
  const attachmentReason = getUnsupportedProviderAttachmentReason(input);
  if (attachmentReason !== null) return { kind: "attachment", reason: attachmentReason };
  return null;
}

export function getUnsupportedProviderInputBannerCopy(restriction: {
  readonly kind: UnsupportedProviderInputKind;
}): { readonly title: string } {
  switch (restriction.kind) {
    case "attachment":
      return { title: "Image attachments unavailable" };
    case "unknown":
      return { title: "Waiting for the server" };
    default:
      return { title: "Provider mode unavailable" };
  }
}
