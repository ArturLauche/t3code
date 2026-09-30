import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions } from "./RuntimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("requires explicit registration of every PR and stack layer", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex", supportsMcpTooling: true });
    expect(instructions).toContain("When the t3-code MCP server exposes link_pull_request");
    expect(instructions).toContain("with the full PR URL immediately after creating a PR");
    expect(instructions).toContain("For a stack, call it for every layer");
    expect(instructions).toContain("call list_thread_pull_requests and link any PR");
  });

  it("withholds the pull-request instructions unless a call site opts in", () => {
    // Every provider attaches T3 Code's MCP server conditionally. Naming tools
    // that were never registered is a guaranteed failure the user sees, so the
    // omission is the default and a call site has to state the tools are there.
    for (const harness of ["Codex", "Cline", "Freebuff", "OpenCode"]) {
      const instructions = buildRuntimeInstructions({ harness });
      expect(instructions).toContain(`through the ${harness} harness`);
      expect(instructions).not.toContain("t3-code MCP server");
      expect(instructions).not.toContain("link_pull_request");
    }
  });

  it("omits unavailable MCP tooling instructions for terminal-only providers", () => {
    const instructions = buildRuntimeInstructions({
      harness: "Freebuff",
      supportsMcpTooling: false,
    });
    expect(instructions).toContain("through the Freebuff harness");
    expect(instructions).not.toContain("t3-code MCP server");
    expect(instructions).not.toContain("link_pull_request");
  });

  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
        supportsMcpTooling: true,
      }),
    ).toContain("through the Codex harness, as custom model with high reasoning effort.");
  });

  it("names the model by display name and slug when they differ", () => {
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "gpt-5.4", modelName: "GPT-5.4" }),
    ).toContain("through the Codex harness, as GPT-5.4 (model slug: gpt-5.4).");
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "my-model", modelName: "my-model" }),
    ).toContain("through the Codex harness, as my-model.");
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });
});
