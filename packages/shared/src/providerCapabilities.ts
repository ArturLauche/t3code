/**
 * Provider capability gating, shared by web and mobile.
 *
 * Some provider CLIs can only honor part of what T3 Code offers — a single
 * approve-everything tool policy, no image ingest, no mid-session mode switch.
 * The server declares that on the `ServerProvider` snapshot
 * (`supportedRuntimeModes`, `supportsImageAttachments`,
 * `showInteractionModeToggle`), and these helpers are the one place clients ask
 * what that means. Keeping them here is the point: a provider-shaped branch in a
 * composer is how capability work turns into scattered `driver === "..."` checks
 * that drift between surfaces.
 *
 * @module shared/providerCapabilities
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
>;

/** The narrowest shape the mode helpers need, for callers holding only a list. */
export type RuntimeModeCapabilitySnapshot = Pick<
  ProviderCapabilitySnapshot,
  "supportedRuntimeModes"
>;

/** Every access mode, in the order the access-mode picker lists them. */
export const ALL_RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

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
 * The mode the picker should steer toward: the widest grant the provider
 * actually supports, else the narrowest one it lists.
 */
function suggestedRuntimeMode(supported: ReadonlyArray<RuntimeMode>): RuntimeMode | undefined {
  if (supported.includes("full-access")) return "full-access";
  return supported[0];
}

function unsupportedRuntimeModeReason(
  provider: ProviderCapabilitySnapshot,
  supported: ReadonlyArray<RuntimeMode>,
): string {
  const label = providerLabel(provider);
  const suggestion = suggestedRuntimeMode(supported);
  if (!suggestion) {
    return `${label} does not declare any supported access mode. Re-check the provider in Settings.`;
  }
  return `${label} does not support the selected access mode. Choose ${RUNTIME_MODE_LABELS[suggestion]} to continue.`;
}

function planUnsupportedReason(provider: ProviderCapabilitySnapshot): string {
  return `${providerLabel(provider)} does not support Plan mode. Choose Build to continue.`;
}

export function providerShowsInteractionModeToggle(
  provider: ProviderCapabilitySnapshot | null | undefined,
  interactionMode: ProviderInteractionMode | undefined,
): boolean {
  if (interactionMode === "plan") return true;
  return provider?.showInteractionModeToggle !== false;
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
  const supported = getProviderSupportedRuntimeModes(provider);
  if (supported.length === 0) {
    return unsupportedRuntimeModeReason(provider, supported);
  }
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

export function getUnsupportedProviderAttachmentReason(input: {
  readonly provider: ProviderCapabilitySnapshot | null | undefined;
  readonly attachmentCount: number;
}): string | null {
  if (input.attachmentCount === 0) return null;
  if (providerSupportsImageAttachments(input.provider)) return null;
  return `${providerLabel(input.provider)} does not support image attachments. Remove the images to continue.`;
}

export type UnsupportedProviderInputKind = "mode" | "attachment";

/** Single source for the composer's send gate and its banner copy. */
export function getUnsupportedProviderInputReason(input: {
  readonly provider: ProviderCapabilitySnapshot | null | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly attachmentCount: number;
}): { readonly kind: UnsupportedProviderInputKind; readonly reason: string } | null {
  const modeReason = getUnsupportedProviderModeReason(input);
  if (modeReason !== null) return { kind: "mode", reason: modeReason };
  const attachmentReason = getUnsupportedProviderAttachmentReason(input);
  if (attachmentReason !== null) return { kind: "attachment", reason: attachmentReason };
  return null;
}

export function getUnsupportedProviderInputBannerCopy(restriction: {
  readonly kind: UnsupportedProviderInputKind;
  readonly reason: string;
}): { readonly title: string } {
  return {
    title:
      restriction.kind === "attachment"
        ? "Image attachments unavailable"
        : "Provider mode unavailable",
  };
}
