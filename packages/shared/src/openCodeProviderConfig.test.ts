import { describe, expect, it } from "vite-plus/test";

import {
  mergeOpenCodeProviderConfig,
  openCodeProviderEntries,
  readOpenCodeProviderSettings,
  toOpenCodeProviderSettings,
  type OpenCodeProviderEntry,
  validateOpenCodeBaseUrl,
  validateOpenCodeModelId,
  validateOpenCodeProviderEntry,
  validateOpenCodeProviderId,
  withOpenCodeProviderConfig,
} from "./openCodeProviderConfig.ts";

const makeEntry = (overrides: Partial<OpenCodeProviderEntry> = {}): OpenCodeProviderEntry => ({
  providerId: "local",
  env: [],
  apiKey: "",
  apiKeyRedacted: false,
  models: [],
  ...overrides,
});

describe("readOpenCodeProviderSettings", () => {
  it("returns an empty map for anything that is not a provider map", () => {
    expect(readOpenCodeProviderSettings(undefined)).toEqual({});
    expect(readOpenCodeProviderSettings(null)).toEqual({});
    expect(readOpenCodeProviderSettings([{ providerId: "local" }])).toEqual({});
    expect(readOpenCodeProviderSettings({ local: "nope" })).toEqual({});
  });

  it("drops rows that would not survive a round trip and keeps the good ones", () => {
    const read = readOpenCodeProviderSettings({
      "bad id": {},
      local: {
        baseUrl: "  https://proxy.internal/v1  ",
        env: ["PROXY_KEY", "PROXY_KEY", "  "],
        models: [
          { modelId: "vendor/large", reasoning: true, variants: ["low", "low", "high"] },
          { modelId: "/bad", name: "Bad" },
          { name: "No id" },
        ],
      },
    });
    expect(Object.keys(read)).toEqual(["local"]);
    expect(read.local?.baseUrl).toBe("https://proxy.internal/v1");
    expect(read.local?.env).toEqual(["PROXY_KEY"]);
    // Deduplication keeps the first occurrence and drops the bad rows.
    expect(read.local?.models).toEqual([
      { modelId: "vendor/large", reasoning: true, variants: ["low", "high"] },
    ]);
  });
});

describe("openCodeProviderEntries / toOpenCodeProviderSettings", () => {
  it("defaults editable fields and returns entries in id order", () => {
    const entries = openCodeProviderEntries(
      readOpenCodeProviderSettings({
        zeta: {},
        alpha: { apiKeyRedacted: true },
      }),
    );
    expect(entries.map((entry) => entry.providerId)).toEqual(["alpha", "zeta"]);
    expect(entries[0]).toMatchObject({ env: [], apiKey: "", apiKeyRedacted: true, models: [] });
  });

  it("omits blank fields so settings.json stays sparse", () => {
    const persisted = toOpenCodeProviderSettings(
      makeEntry({
        providerId: "local",
        name: "  ",
        npm: "",
        baseUrl: " ",
        apiKey: "",
        apiKeyRedacted: false,
        env: ["  "],
        models: [],
      }),
    );
    expect(persisted).toEqual({});
  });

  it("round-trips a model id through the persisted shape", () => {
    const entry = makeEntry({ providerId: "openai", models: [{ modelId: "gpt-next" }] });
    expect(toOpenCodeProviderSettings(entry)).toEqual({ models: [{ modelId: "gpt-next" }] });
    // Reading it back must yield the same entry, or the editor loses the row.
    expect(
      openCodeProviderEntries(
        readOpenCodeProviderSettings({ openai: toOpenCodeProviderSettings(entry) }),
      ),
    ).toEqual([
      {
        providerId: "openai",
        name: undefined,
        npm: undefined,
        env: [],
        baseUrl: undefined,
        apiKey: "",
        apiKeyRedacted: false,
        timeout: undefined,
        models: [{ modelId: "gpt-next" }],
      },
    ]);
  });

  it("keeps the redaction marker and drops the key it stands in for", () => {
    expect(toOpenCodeProviderSettings(makeEntry({ apiKeyRedacted: true, apiKey: "" }))).toEqual({
      apiKeyRedacted: true,
    });
  });
});

describe("mergeOpenCodeProviderConfig", () => {
  it("returns the base document untouched when nothing is configured", () => {
    expect(mergeOpenCodeProviderConfig({ entries: [] })).toBe("{}");
    expect(mergeOpenCodeProviderConfig({ configContent: '{"a":1}', entries: [] })).toBe('{"a":1}');
  });

  it("writes OpenCode's provider.<id> shape, not T3's own field names", () => {
    const merged = JSON.parse(
      mergeOpenCodeProviderConfig({
        entries: [
          makeEntry({
            providerId: "myproxy",
            name: "My Proxy",
            npm: "@ai-sdk/openai-compatible",
            env: ["PROXY_KEY"],
            baseUrl: "https://proxy.internal/v1",
            apiKey: "sk-proxy",
            timeout: 30_000,
            models: [
              {
                modelId: "vendor/large",
                id: "large",
                name: "Vendor Large",
                reasoning: true,
                attachment: true,
                toolCall: false,
                temperature: true,
                contextLimit: 200_000,
                outputLimit: 64_000,
                status: "beta",
                variants: ["low", "high"],
              },
            ],
          }),
        ],
      }),
    );
    expect(merged).toEqual({
      provider: {
        myproxy: {
          name: "My Proxy",
          npm: "@ai-sdk/openai-compatible",
          env: ["PROXY_KEY"],
          options: {
            baseURL: "https://proxy.internal/v1",
            apiKey: "sk-proxy",
            timeout: 30_000,
          },
          models: {
            "vendor/large": {
              id: "large",
              name: "Vendor Large",
              reasoning: true,
              attachment: true,
              temperature: true,
              tool_call: false,
              limit: { context: 200_000, output: 64_000 },
              status: "beta",
              variants: { low: {}, high: {} },
            },
          },
        },
      },
    });
  });

  it("declaring a model id alone is enough — the rest of the entry may be empty", () => {
    const merged = JSON.parse(
      mergeOpenCodeProviderConfig({
        entries: [makeEntry({ providerId: "openai", models: [{ modelId: "gpt-next" }] })],
      }),
    );
    expect(merged.provider.openai).toEqual({ models: { "gpt-next": {} } });
  });

  it("keeps unrelated config and unmanaged providers from the caller's document", () => {
    const merged = JSON.parse(
      mergeOpenCodeProviderConfig({
        configContent: JSON.stringify({
          model: "anthropic/claude-sonnet-5",
          provider: {
            openai: { options: { baseURL: "https://hand-written" } },
            kept: { name: "Kept" },
          },
        }),
        entries: [makeEntry({ providerId: "openai", apiKey: "sk-openai" })],
      }),
    );
    expect(merged.model).toBe("anthropic/claude-sonnet-5");
    expect(merged.provider.kept).toEqual({ name: "Kept" });
    // T3's key wins, the caller's baseURL survives because T3 did not set one.
    expect(merged.provider.openai).toEqual({
      options: { baseURL: "https://hand-written", apiKey: "sk-openai" },
    });
  });

  it("merges model maps so removing one T3 model does not resurrect it from the base", () => {
    const merged = JSON.parse(
      mergeOpenCodeProviderConfig({
        configContent: JSON.stringify({
          provider: { openai: { models: { "hand-written": {}, "gpt-next": { name: "Old" } } } },
        }),
        entries: [
          makeEntry({ providerId: "openai", models: [{ modelId: "gpt-next", name: "New" }] }),
        ],
      }),
    );
    expect(Object.keys(merged.provider.openai.models)).toEqual(["hand-written", "gpt-next"]);
    expect(merged.provider.openai.models["gpt-next"]).toEqual({ name: "New" });
  });

  it("survives a base document that is not parseable JSON", () => {
    const merged = JSON.parse(
      mergeOpenCodeProviderConfig({
        configContent: "{not json",
        entries: [makeEntry({ providerId: "local", apiKey: "sk" })],
      }),
    );
    expect(merged.provider.local.options.apiKey).toBe("sk");
  });

  it("skips an entry whose provider id is not a usable slug", () => {
    const merged = mergeOpenCodeProviderConfig({
      entries: [makeEntry({ providerId: "not a slug", apiKey: "sk" })],
    });
    expect(merged).toBe("{}");
  });
});

describe("withOpenCodeProviderConfig", () => {
  it("leaves the environment alone when nothing is configured", () => {
    const environment = { OPENCODE_CONFIG_CONTENT: '{"a":1}' };
    expect(withOpenCodeProviderConfig({ environment, entries: [] })).toBe(environment);
  });

  it("merges into the config the instance already carries", () => {
    const merged = withOpenCodeProviderConfig({
      environment: { OPENCODE_CONFIG_CONTENT: '{"model":"anthropic/claude-sonnet-5"}' },
      entries: [makeEntry({ providerId: "local", apiKey: "sk" })],
    });
    expect(JSON.parse(merged.OPENCODE_CONFIG_CONTENT ?? "{}")).toEqual({
      model: "anthropic/claude-sonnet-5",
      provider: { local: { options: { apiKey: "sk" } } },
    });
  });
});

describe("validation", () => {
  it("accepts and rejects provider ids", () => {
    expect(validateOpenCodeProviderId("  ")).toMatchObject({ field: "providerId" });
    expect(validateOpenCodeProviderId("-leading-dash")?.message).toMatch(/starting with/);
    expect(validateOpenCodeProviderId("openrouter")).toBeNull();
    expect(validateOpenCodeProviderId("my-proxy.v2_1")).toBeNull();
    expect(validateOpenCodeProviderId("has space")).not.toBeNull();
  });

  it("accepts inner slashes in model ids but not outer ones", () => {
    expect(validateOpenCodeModelId("aion-labs/aion-3.5")).toBeNull();
    expect(validateOpenCodeModelId("/leading")).not.toBeNull();
    expect(validateOpenCodeModelId("trailing/")).not.toBeNull();
    expect(validateOpenCodeModelId("  ")).not.toBeNull();
  });

  it("checks base URLs are absolute http(s) URLs", () => {
    expect(validateOpenCodeBaseUrl("")).toBeNull();
    expect(validateOpenCodeBaseUrl("https://proxy.internal/v1")).toBeNull();
    expect(validateOpenCodeBaseUrl("proxy.internal/v1")).not.toBeNull();
    expect(validateOpenCodeBaseUrl("ftp://proxy.internal")).not.toBeNull();
  });

  it("requires the two token limits together, because OpenCode rejects a half-specified limit", () => {
    expect(
      validateOpenCodeProviderEntry({
        ...makeEntry({ providerId: "openai", models: [{ modelId: "big", contextLimit: 200_000 }] }),
      }),
    ).toEqual([
      { field: "models", message: expect.stringContaining("context window and a maximum output") },
    ]);
    expect(
      validateOpenCodeProviderEntry(
        makeEntry({
          providerId: "openai",
          models: [{ modelId: "big", contextLimit: 200_000, outputLimit: 64_000 }],
        }),
      ),
    ).toEqual([]);
  });

  it("reports every problem with an entry at once, including duplicates", () => {
    const issues = validateOpenCodeProviderEntry(
      makeEntry({
        providerId: "bad id",
        baseUrl: "nope",
        models: [{ modelId: "dup" }, { modelId: "dup" }],
      }),
    );
    // A duplicate is reported once — the second row is the problem.
    expect(issues.map((issue) => issue.field).toSorted()).toEqual([
      "baseUrl",
      "models",
      "providerId",
    ]);
    expect(issues.find((issue) => issue.message.includes("twice"))).toBeDefined();
  });
});
