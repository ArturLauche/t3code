import { describe, expect, it } from "vite-plus/test";

import { redactGitHubSecrets } from "./redaction.ts";

describe("GitHub secret redaction", () => {
  it("redacts classic and fine-grained GitHub token formats", () => {
    expect(
      redactGitHubSecrets(
        "failed ghp_abcdefghijklmnopqrstuvwxyz012345 github_pat_abcdefghijklmnopqrstuvwxyz012345",
      ),
    ).toBe("failed [REDACTED] [REDACTED]");
  });

  it("preserves useful Error messages while redacting secrets", () => {
    expect(
      redactGitHubSecrets(
        new Error("request failed for github_pat_abcdefghijklmnopqrstuvwxyz012345"),
      ),
    ).toBe("request failed for [REDACTED]");
  });
});
