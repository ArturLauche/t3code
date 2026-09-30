import { describe, expect, it } from "vite-plus/test";
import type { OpenCodeProviderSettingsMap, ServerProviderModel } from "@t3tools/contracts";

import {
  describeOpenCodeModel,
  discoverOpenCodeProviders,
  findOpenCodeProviderEntry,
  isModelReportedByOpenCode,
  newOpenCodeModelEntry,
  newOpenCodeProviderEntry,
  openCodeProviderIssues,
  readInstanceOpenCodeProviders,
  upsertOpenCodeProvider,
  withInstanceOpenCodeProviders,
  withOpenCodeProviderModel,
  withoutOpenCodeProvider,
  withoutOpenCodeProviderModel,
} from "./openCodeProviders.logic";

const model = (slug: string, subProvider?: string): ServerProviderModel => ({
  slug,
  name: slug.split("/").at(-1) ?? slug,
  ...(subProvider ? { subProvider } : {}),
  isCustom: false,
  capabilities: null,
});

describe("discoverOpenCodeProviders", () => {
  it("groups the reported models by their provider id", () => {
    expect(
      discoverOpenCodeProviders([
        model("openai/gpt-5.4", "OpenAI"),
        model("openai/gpt-next", "OpenAI"),
        model("anthropic/claude-sonnet-5", "Anthropic"),
      ]),
    ).toEqual([
      { providerId: "anthropic", name: "Anthropic", modelIds: ["claude-sonnet-5"] },
      { providerId: "openai", name: "OpenAI", modelIds: ["gpt-5.4", "gpt-next"] },
    ]);
  });

  it("keeps the inner slash of a provider-qualified model id", () => {
    expect(
      discoverOpenCodeProviders([model("openrouter/aion-labs/aion-3.5", "OpenRouter")]),
    ).toEqual([{ providerId: "openrouter", name: "OpenRouter", modelIds: ["aion-labs/aion-3.5"] }]);
  });

  it("falls back to the provider id when OpenCode reported no display name", () => {
    expect(discoverOpenCodeProviders([model("local/vendor/large")])).toEqual([
      { providerId: "local", name: "local", modelIds: ["vendor/large"] },
    ]);
  });

  it("ignores slugs that are not a provider-qualified model id", () => {
    expect(
      discoverOpenCodeProviders([model("gpt-5.4"), model("/leading"), model("trailing/")]),
    ).toEqual([]);
  });
});

describe("instance config round trip", () => {
  it("keeps other driver settings while adding and removing the provider map", () => {
    const config = { binaryPath: "opencode", serverUrl: "" };
    const withProviders = withInstanceOpenCodeProviders(config, {
      local: { baseUrl: "http://127.0.0.1:1234/v1" },
    });
    expect(withProviders).toEqual({
      binaryPath: "opencode",
      serverUrl: "",
      providers: { local: { baseUrl: "http://127.0.0.1:1234/v1" } },
    });
    expect(readInstanceOpenCodeProviders(withProviders).local?.baseUrl).toBe(
      "http://127.0.0.1:1234/v1",
    );

    // Removing the last provider drops the key entirely rather than persisting
    // an empty map.
    expect(withInstanceOpenCodeProviders(withProviders, {})).toEqual(config);
    expect(withInstanceOpenCodeProviders(undefined, { local: {} })).toEqual({
      providers: { local: {} },
    });
  });

  it("reads nothing from a config blob that has no provider map", () => {
    expect(readInstanceOpenCodeProviders({ binaryPath: "opencode" })).toEqual({});
    expect(readInstanceOpenCodeProviders(null)).toEqual({});
    expect(readInstanceOpenCodeProviders({ providers: "nope" })).toEqual({});
  });
});

describe("provider map edits", () => {
  const base: OpenCodeProviderSettingsMap = {
    openai: { models: [{ modelId: "gpt-next" }] },
  };

  it("adds, edits and removes a provider without touching the others", () => {
    const added = upsertOpenCodeProvider(base, newOpenCodeProviderEntry("local", "My Proxy"));
    expect(Object.keys(added).toSorted()).toEqual(["local", "openai"]);

    const removed = withoutOpenCodeProvider(added, "local");
    expect(Object.keys(removed)).toEqual(["openai"]);
    expect(removed.openai).toEqual(base.openai);
  });

  it("replaces a model rather than appending a second row for the same id", () => {
    const entry = findOpenCodeProviderEntry(base, "openai");
    expect(entry).toBeDefined();
    const next = withOpenCodeProviderModel(entry!, { modelId: "gpt-next", name: "GPT Next" });
    expect(next.models).toEqual([{ modelId: "gpt-next", name: "GPT Next" }]);

    const appended = withOpenCodeProviderModel(next, newOpenCodeModelEntry("gpt-after"));
    expect(appended.models.map((model) => model.modelId)).toEqual(["gpt-next", "gpt-after"]);
  });

  it("removes a single model and leaves the rest of the provider intact", () => {
    const entry = findOpenCodeProviderEntry(base, "openai")!;
    const withTwo = withOpenCodeProviderModel(entry, { modelId: "gpt-other" });
    expect(withoutOpenCodeProviderModel(withTwo, "gpt-next").models).toEqual([
      { modelId: "gpt-other" },
    ]);
    expect(withoutOpenCodeProviderModel(withTwo, "gpt-next").providerId).toBe("openai");
  });
});

describe("openCodeProviderIssues", () => {
  it("flags a bad provider id, a bad base URL and a duplicate model together", () => {
    const issues = openCodeProviderIssues({
      providerId: "not valid",
      env: [],
      apiKey: "",
      apiKeyRedacted: false,
      baseUrl: "proxy.internal",
      models: [{ modelId: "dup" }, { modelId: "dup" }],
    });
    expect(issues.map((issue) => issue.field).toSorted()).toEqual([
      "baseUrl",
      "models",
      "providerId",
    ]);
  });

  it("accepts an entry that declares only model ids", () => {
    expect(
      openCodeProviderIssues({
        providerId: "openai",
        env: [],
        apiKey: "",
        apiKeyRedacted: false,
        models: [{ modelId: "gpt-next" }],
      }),
    ).toEqual([]);
  });
});

describe("model presentation", () => {
  it("summarizes the capability switches a row shows", () => {
    expect(
      describeOpenCodeModel({
        modelId: "big",
        reasoning: true,
        attachment: true,
        contextLimit: 200_000,
      }),
    ).toEqual(["Reasoning", "Images", "200k context"]);
    expect(describeOpenCodeModel({ modelId: "plain" })).toEqual([]);
  });

  it("knows whether OpenCode already reports a model", () => {
    const models = [model("openai/gpt-5.4")];
    expect(isModelReportedByOpenCode({ providerId: "openai", modelId: "gpt-5.4", models })).toBe(
      true,
    );
    expect(isModelReportedByOpenCode({ providerId: "openai", modelId: "gpt-next", models })).toBe(
      false,
    );
  });
});
