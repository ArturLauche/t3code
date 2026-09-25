import { describe, expect, it } from "vite-plus/test";

import { FreebuffDriver, freebuffCredentialsHaveToken } from "./FreebuffDriver.ts";

describe("FreebuffDriver", () => {
  it("keeps Freebuff local and single-instance", () => {
    expect(FreebuffDriver.metadata).toMatchObject({
      supportsCloudExecution: false,
      supportsMultipleInstances: false,
    });
  });

  it("only treats a non-empty default token as credentials", () => {
    expect(
      freebuffCredentialsHaveToken(
        JSON.stringify({ default: { authToken: "token" }, other: { authToken: "other" } }),
      ),
    ).toBe(true);
    expect(freebuffCredentialsHaveToken(JSON.stringify({ default: {} }))).toBe(false);
    expect(freebuffCredentialsHaveToken(JSON.stringify({ default: { authToken: "  " } }))).toBe(
      false,
    );
    expect(freebuffCredentialsHaveToken("not-json")).toBe(false);
  });
});
