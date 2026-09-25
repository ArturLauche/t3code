import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type RuntimeMode, type ServerProvider } from "@t3tools/contracts";

import {
  ALL_RUNTIME_MODES,
  getProviderSupportedRuntimeModes,
  getUnsupportedProviderAttachmentReason,
  getUnsupportedProviderInputBannerCopy,
  getUnsupportedProviderInputReason,
  getUnsupportedProviderModeReason,
  providerSupportsImageAttachments,
  providerSupportsRuntimeMode,
  RUNTIME_MODE_LABELS,
  type ProviderCapabilitySnapshot,
} from "./providerCapabilities.ts";

const provider = (
  overrides: Partial<ProviderCapabilitySnapshot> = {},
): ProviderCapabilitySnapshot => ({
  displayName: "Cline",
  driver: ProviderDriverKind.make("cline"),
  ...overrides,
});

const ALL_MODES: ReadonlyArray<RuntimeMode> = ALL_RUNTIME_MODES;

describe("getProviderSupportedRuntimeModes", () => {
  it("treats an absent declaration as every mode", () => {
    expect(getProviderSupportedRuntimeModes(provider())).toEqual(ALL_MODES);
    expect(getProviderSupportedRuntimeModes(null)).toEqual(ALL_MODES);
    // An empty list is not "no restriction"; it would leave the picker with
    // nothing to offer and no way to recover.
    expect(getProviderSupportedRuntimeModes(provider({ supportedRuntimeModes: [] }))).toEqual(
      ALL_MODES,
    );
  });

  it("returns exactly what the provider declares", () => {
    const declared = ["approval-required", "full-access"] as const;
    expect(getProviderSupportedRuntimeModes(provider({ supportedRuntimeModes: declared }))).toEqual(
      ["approval-required", "full-access"],
    );
  });
});

describe("providerSupportsRuntimeMode", () => {
  it("is true for every mode when the provider declares nothing", () => {
    for (const mode of ALL_MODES) {
      expect(providerSupportsRuntimeMode(provider(), mode)).toBe(true);
    }
  });

  it("narrows to the declared set", () => {
    const cline = provider({ supportedRuntimeModes: ["approval-required", "full-access"] });
    expect(providerSupportsRuntimeMode(cline, "approval-required")).toBe(true);
    expect(providerSupportsRuntimeMode(cline, "full-access")).toBe(true);
    expect(providerSupportsRuntimeMode(cline, "auto")).toBe(false);
    expect(providerSupportsRuntimeMode(cline, "auto-accept-edits")).toBe(false);
  });
});

describe("getUnsupportedProviderModeReason", () => {
  it("says nothing when the mode is supported and Plan is off the table", () => {
    expect(
      getUnsupportedProviderModeReason({
        provider: provider({ supportedRuntimeModes: ["approval-required", "full-access"] }),
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
    ).toBeNull();
    expect(
      getUnsupportedProviderModeReason({
        provider: null,
        runtimeMode: "auto",
        interactionMode: "plan",
      }),
    ).toBeNull();
  });

  it("explains an unsupported access mode and names a mode that works", () => {
    const reason = getUnsupportedProviderModeReason({
      provider: provider({ supportedRuntimeModes: ["approval-required", "full-access"] }),
      runtimeMode: "auto",
      interactionMode: "default",
    });
    expect(reason).toContain("Cline does not support the selected access mode");
    // The suggestion must be one of the declared modes, never a hard-coded one.
    expect(reason).toContain(RUNTIME_MODE_LABELS["full-access"]);
  });

  it("picks the narrowest declared mode when full access is unavailable", () => {
    const reason = getUnsupportedProviderModeReason({
      provider: provider({ supportedRuntimeModes: ["approval-required"] }),
      runtimeMode: "auto",
      interactionMode: "default",
    });
    expect(reason).toContain(RUNTIME_MODE_LABELS["approval-required"]);
    expect(reason).not.toContain(RUNTIME_MODE_LABELS["full-access"]);
  });

  it("treats an empty declaration as unrestricted, not as unrecoverable", () => {
    // Falling back to a hard-coded "Full access" suggestion would name a mode
    // the provider did not declare and leave the picker with no options.
    expect(
      getUnsupportedProviderModeReason({
        provider: provider({ supportedRuntimeModes: [] }),
        runtimeMode: "auto",
        interactionMode: "default",
      }),
    ).toBeNull();
  });

  it("explains an unsupported Plan mode", () => {
    const reason = getUnsupportedProviderModeReason({
      provider: provider({
        supportedRuntimeModes: ["approval-required", "full-access"],
        showInteractionModeToggle: false,
      }),
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    expect(reason).toContain("does not support Plan mode");
    expect(reason).toContain("Choose Build");
  });

  it("prefers the access-mode reason over the Plan reason", () => {
    const reason = getUnsupportedProviderModeReason({
      provider: provider({ supportedRuntimeModes: ["approval-required"] }),
      runtimeMode: "auto",
      interactionMode: "plan",
    });
    expect(reason).toContain("access mode");
  });
});

describe("attachment capabilities", () => {
  it("assumes support when the provider says nothing", () => {
    expect(providerSupportsImageAttachments(provider())).toBe(true);
    expect(providerSupportsImageAttachments(null)).toBe(true);
    expect(
      getUnsupportedProviderAttachmentReason({ provider: provider(), attachmentCount: 3 }),
    ).toBeNull();
  });

  it("rejects images for a provider that declares no image support", () => {
    const cline = provider({ supportsImageAttachments: false });
    expect(providerSupportsImageAttachments(cline)).toBe(false);
    const reason = getUnsupportedProviderAttachmentReason({ provider: cline, attachmentCount: 1 });
    expect(reason).toContain("Cline does not support image attachments");
    // A draft with no images is never blocked for this reason.
    expect(
      getUnsupportedProviderAttachmentReason({ provider: cline, attachmentCount: 0 }),
    ).toBeNull();
  });
});

describe("getUnsupportedProviderInputReason", () => {
  const cline = provider({
    supportedRuntimeModes: ["approval-required", "full-access"],
    supportsImageAttachments: false,
  });

  it("returns null when a turn can be sent as composed", () => {
    expect(
      getUnsupportedProviderInputReason({
        provider: cline,
        runtimeMode: "full-access",
        interactionMode: "default",
        attachmentCount: 0,
      }),
    ).toBeNull();
  });

  it("reports the mode before the attachment", () => {
    expect(
      getUnsupportedProviderInputReason({
        provider: cline,
        runtimeMode: "auto",
        interactionMode: "default",
        attachmentCount: 2,
      }),
    ).toMatchObject({ kind: "mode" });
  });

  it("reports attachments once the mode is fine", () => {
    expect(
      getUnsupportedProviderInputReason({
        provider: cline,
        runtimeMode: "approval-required",
        interactionMode: "default",
        attachmentCount: 2,
      }),
    ).toMatchObject({ kind: "attachment" });
  });

  it("titles each restriction distinctly", () => {
    expect(getUnsupportedProviderInputBannerCopy({ kind: "mode", reason: "x" }).title).toBe(
      "Provider mode unavailable",
    );
    expect(getUnsupportedProviderInputBannerCopy({ kind: "attachment", reason: "x" }).title).toBe(
      "Image attachments unavailable",
    );
  });
});

describe("capability snapshot compatibility", () => {
  it("reads a real provider snapshot without narrowing it", () => {
    const snapshot = {
      displayName: "Cline",
      driver: "cline",
      supportedRuntimeModes: ["approval-required", "full-access"],
      showInteractionModeToggle: false,
      supportsImageAttachments: false,
      models: [],
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      instanceId: "cline",
    } as unknown as ServerProvider;
    expect(
      getUnsupportedProviderModeReason({
        provider: snapshot,
        runtimeMode: "auto",
        interactionMode: "default",
      }),
    ).toContain("Cline does not support the selected access mode");
  });
});
