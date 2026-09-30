import { describe, expect, it } from "vite-plus/test";

import {
  listOpenCodeProviderApiKeys,
  materializeOpenCodeProviderApiKeys,
  openCodeProviderApiKeySecretName,
  planOpenCodeProviderApiKeyPersistence,
  redactOpenCodeProviderApiKeys,
} from "./openCodeProviderSecrets.ts";

describe("openCodeProviderApiKeySecretName", () => {
  it("is stable per instance and provider, and keeps both names out of the filename", () => {
    const name = openCodeProviderApiKeySecretName({
      instanceId: "opencode",
      providerId: "my proxy",
    });
    expect(name).toBe(
      openCodeProviderApiKeySecretName({ instanceId: "opencode", providerId: "my proxy" }),
    );
    expect(name).not.toContain("my proxy");
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(name).not.toBe(
      openCodeProviderApiKeySecretName({ instanceId: "opencode-work", providerId: "my proxy" }),
    );
  });
});

describe("redactOpenCodeProviderApiKeys", () => {
  it("clears stored keys and marks them redacted", () => {
    const redacted = redactOpenCodeProviderApiKeys({
      binaryPath: "opencode",
      providers: { local: { baseUrl: "https://x/v1", apiKey: "sk-secret" }, other: {} },
    }) as Record<string, Record<string, unknown>>;
    expect(redacted.binaryPath).toBe("opencode");
    expect(redacted.providers?.local).toEqual({
      baseUrl: "https://x/v1",
      apiKey: "",
      apiKeyRedacted: true,
    });
    expect(redacted.providers?.other).toEqual({});
  });

  it("leaves non-OpenCode config blobs and already-redacted entries alone", () => {
    const untouched = { binaryPath: "opencode", customModels: [] };
    expect(redactOpenCodeProviderApiKeys(untouched)).toBe(untouched);
    const already = { providers: { local: { apiKey: "", apiKeyRedacted: true } } };
    expect(redactOpenCodeProviderApiKeys(already)).toBe(already);
  });
});

describe("listOpenCodeProviderApiKeys", () => {
  it("only reports entries that hold or defer to a key", () => {
    expect(
      listOpenCodeProviderApiKeys({
        providers: {
          plain: { baseUrl: "https://x/v1" },
          keyed: { apiKey: "sk-1" },
          redacted: { apiKey: "", apiKeyRedacted: true },
          malformed: "nope",
        },
      }),
    ).toEqual([
      { providerId: "keyed", apiKey: "sk-1", apiKeyRedacted: false },
      { providerId: "redacted", apiKey: "", apiKeyRedacted: true },
    ]);
  });
});

describe("materializeOpenCodeProviderApiKeys", () => {
  it("fills redacted entries from the store and leaves inline keys", () => {
    const materialized = materializeOpenCodeProviderApiKeys(
      {
        providers: {
          stored: { apiKey: "", apiKeyRedacted: true },
          inline: { apiKey: "sk-inline" },
        },
      },
      (providerId) => (providerId === "stored" ? "sk-stored" : ""),
    ) as Record<string, Record<string, unknown>>;
    expect(materialized.providers?.stored).toEqual({ apiKey: "sk-stored", apiKeyRedacted: true });
    expect(materialized.providers?.inline).toEqual({ apiKey: "sk-inline" });
  });

  it("treats a missing secret as no key rather than failing the load", () => {
    const materialized = materializeOpenCodeProviderApiKeys(
      { providers: { stored: { apiKey: "", apiKeyRedacted: true } } },
      () => "",
    ) as Record<string, Record<string, unknown>>;
    expect(materialized.providers?.stored).toEqual({ apiKey: "", apiKeyRedacted: true });
  });
});

describe("planOpenCodeProviderApiKeyPersistence", () => {
  it("moves a new key to the secret store and leaves only the marker on disk", () => {
    const plan = planOpenCodeProviderApiKeyPersistence({
      nextConfig: { providers: { local: { apiKey: "sk-new" } } },
      currentConfig: undefined,
    });
    expect(plan.writes).toEqual([{ providerId: "local", value: "sk-new" }]);
    expect(plan.retainedProviderIds).toEqual(["local"]);
    expect(plan.config).toEqual({
      providers: { local: { apiKey: "", apiKeyRedacted: true } },
    });
  });

  it("keeps the stored key when a client echoes the marker back unchanged", () => {
    const plan = planOpenCodeProviderApiKeyPersistence({
      nextConfig: { providers: { local: { apiKey: "", apiKeyRedacted: true } } },
      currentConfig: { providers: { local: { apiKey: "sk-kept" } } },
    });
    expect(plan.writes).toEqual([{ providerId: "local", value: "sk-kept" }]);
    // Retained even though nothing is written: the stored key must survive.
    expect(plan.retainedProviderIds).toEqual(["local"]);
    expect(plan.removedProviderIds).toEqual([]);
    expect(plan.config).toEqual({
      providers: { local: { apiKey: "", apiKeyRedacted: true } },
    });
  });

  it("migrates a key hand-written into settings.json", () => {
    const plan = planOpenCodeProviderApiKeyPersistence({
      nextConfig: { providers: { local: { apiKey: "", apiKeyRedacted: true } } },
      currentConfig: { providers: { local: { apiKey: "sk-hand-written" } } },
    });
    expect(plan.writes).toEqual([{ providerId: "local", value: "sk-hand-written" }]);
  });

  it("clears the key and its secret when the user clears the field", () => {
    const plan = planOpenCodeProviderApiKeyPersistence({
      nextConfig: { providers: { local: { baseUrl: "https://x/v1" } } },
      currentConfig: { providers: { local: { apiKey: "sk-old", apiKeyRedacted: true } } },
    });
    expect(plan.writes).toEqual([]);
    expect(plan.retainedProviderIds).toEqual([]);
    expect(plan.removedProviderIds).toEqual(["local"]);
    expect(plan.config).toEqual({ providers: { local: { baseUrl: "https://x/v1" } } });
  });

  it("removes the secret for a provider the user deleted (materialized current)", () => {
    const plan = planOpenCodeProviderApiKeyPersistence({
      nextConfig: { providers: {} },
      currentConfig: { providers: { local: { apiKey: "sk-old", apiKeyRedacted: true } } },
    });
    expect(plan.removedProviderIds).toEqual(["local"]);
  });

  it("removes the secret for a provider the user deleted", () => {
    const plan = planOpenCodeProviderApiKeyPersistence({
      nextConfig: { providers: {} },
      currentConfig: { providers: { local: { apiKey: "sk-old", apiKeyRedacted: true } } },
    });
    expect(plan.removedProviderIds).toEqual(["local"]);
    expect(plan.writes).toEqual([]);
  });

  it("leaves the config object identity alone when nothing about keys changed", () => {
    const nextConfig = { providers: { local: { apiKey: "", apiKeyRedacted: true } } };
    const plan = planOpenCodeProviderApiKeyPersistence({
      nextConfig,
      currentConfig: { providers: { local: { apiKey: "sk-old" } } },
    });
    expect(plan.config).toBe(nextConfig);
  });

  it("keeps unrelated driver settings in the blob", () => {
    const plan = planOpenCodeProviderApiKeyPersistence({
      nextConfig: { binaryPath: "opencode", serverUrl: "", providers: { local: { apiKey: "sk" } } },
      currentConfig: undefined,
    });
    expect(plan.config).toEqual({
      binaryPath: "opencode",
      serverUrl: "",
      providers: { local: { apiKey: "", apiKeyRedacted: true } },
    });
  });
});
