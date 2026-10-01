import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  OPEN_CODE_MAX_MODEL_ID_LENGTH,
  OPEN_CODE_MAX_PROVIDER_ID_LENGTH,
  OpenCodeProviderSettingsMap,
} from "./openCodeProvider.ts";
import { OpenCodeSettings } from "./settings.ts";

const decodeProviderMap = Schema.decodeUnknownSync(OpenCodeProviderSettingsMap);
const decodeOpenCodeSettings = Schema.decodeUnknownSync(OpenCodeSettings);

describe("OpenCodeProviderSettingsMap", () => {
  it("keeps a full provider entry, including its ordered model list", () => {
    const decoded = decodeProviderMap({
      myproxy: {
        name: "My Proxy",
        npm: "@ai-sdk/openai-compatible",
        env: ["MY_PROXY_KEY"],
        baseUrl: "https://proxy.internal/v1",
        timeout: 30_000,
        models: [
          {
            modelId: "vendor/large",
            name: "Vendor Large",
            reasoning: true,
            attachment: true,
            toolCall: true,
            contextLimit: 200_000,
            outputLimit: 64_000,
            status: "beta",
            variants: ["low", "high"],
          },
        ],
      },
    });
    expect(decoded.myproxy?.models?.[0]?.modelId).toBe("vendor/large");
    expect(decoded.myproxy?.models?.[0]?.variants).toEqual(["low", "high"]);
    expect(decoded.myproxy?.baseUrl).toBe("https://proxy.internal/v1");
  });

  it("rejects provider ids that would not survive the model-slug split", () => {
    expect(() => decodeProviderMap({ "not a slug": {} })).toThrow();
    expect(() => decodeProviderMap({ "/leading": {} })).toThrow();
    expect(() => decodeProviderMap({ "": {} })).toThrow();
    const tooLongId = "x".repeat(OPEN_CODE_MAX_PROVIDER_ID_LENGTH + 1);
    expect(() => decodeProviderMap({ [tooLongId]: {} })).toThrow();
  });

  it("rejects model ids that produce an unparseable composite slug", () => {
    expect(() =>
      decodeProviderMap({ openai: { models: [{ modelId: "/leading-slash" }] } }),
    ).toThrow();
    expect(() => decodeProviderMap({ openai: { models: [{ modelId: "trailing/" }] } })).toThrow();
    const tooLongModelId = "x".repeat(OPEN_CODE_MAX_MODEL_ID_LENGTH + 1);
    expect(() =>
      decodeProviderMap({ openai: { models: [{ modelId: tooLongModelId }] } }),
    ).toThrow();
  });

  it("accepts a model id that contains an inner slash", () => {
    const decoded = decodeProviderMap({
      openrouter: { models: [{ modelId: "aion-labs/aion-3.5" }] },
    });
    expect(decoded.openrouter?.models?.[0]?.modelId).toBe("aion-labs/aion-3.5");
  });

  it("round-trips the redaction marker used for stored API keys", () => {
    const decoded = decodeProviderMap({ openai: { apiKey: "", apiKeyRedacted: true } });
    expect(decoded.openai).toEqual({ apiKey: "", apiKeyRedacted: true });
  });
});

describe("OpenCodeSettings", () => {
  it("defaults providers to an empty map", () => {
    expect(decodeOpenCodeSettings({}).providers).toEqual({});
  });

  it("decodes a configured provider map", () => {
    const settings = decodeOpenCodeSettings({
      enabled: true,
      providers: { local: { baseUrl: "http://127.0.0.1:1234/v1", apiKey: "sk-local" } },
    });
    expect(settings.providers.local?.baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(settings.providers.local?.apiKey).toBe("sk-local");
  });
});
