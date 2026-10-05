import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { DRIVER_OPTION_BY_VALUE, DRIVER_OPTIONS, getDriverOption } from "./providerDriverMeta.ts";
import { providerIconForDriverKind } from "../chat/ProviderInstanceIcon.tsx";
import { ClineIcon } from "../Icons.tsx";

const CLINE = ProviderDriverKind.make("cline");

describe("Cline provider registration", () => {
  it("appears in the settings driver list as a first-class provider", () => {
    const definition = DRIVER_OPTION_BY_VALUE[CLINE];
    expect(definition).toBeDefined();
    expect(definition?.label).toBe("Cline");
    // The ACP binding is still early access, so the card must say so.
    expect(definition?.badgeLabel).toBe("Early Access");
    // The CLI has no cloud spawn override, so the card must not offer it.
    expect(definition?.supportsCloudExecution).toBe(false);
    expect(DRIVER_OPTIONS.map((option) => option.value)).toContain(CLINE);
  });

  it("exposes the Cline settings schema so Settings renders its fields", () => {
    const fields = getDriverOption(CLINE)?.settingsSchema.fields;
    expect(Object.keys(fields ?? {}).toSorted()).toEqual([
      "binaryPath",
      "customModels",
      "dataDir",
      "enabled",
    ]);
  });

  it("resolves the provider icon for the chat surfaces", () => {
    // `ProviderInstanceIcon` owns the driver-kind to icon map; the settings card
    // renders it rather than a per-definition `icon` field.
    expect(providerIconForDriverKind(CLINE)).toBe(ClineIcon);
  });
});
