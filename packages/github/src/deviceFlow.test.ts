import type { OAuthAppAuthentication } from "@octokit/auth-oauth-device";
import { describe, expect, it, vi } from "vite-plus/test";

import { GitHubDeviceFlow } from "./deviceFlow.ts";

const deviceAuth = vi.hoisted(() => ({
  create: vi.fn(),
  resolve: null as null | ((authentication: OAuthAppAuthentication) => void),
}));

vi.mock("@octokit/auth-oauth-device", () => ({
  createOAuthDeviceAuth: deviceAuth.create,
}));

describe("GitHub device authorization state", () => {
  it("moves from pending to complete and can be cleared", async () => {
    deviceAuth.create.mockImplementation(
      (options: { onVerification: (value: unknown) => void }) => {
        options.onVerification({
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        });
        return () =>
          new Promise<OAuthAppAuthentication>((resolve) => {
            deviceAuth.resolve = resolve;
          });
      },
    );
    const flow = new GitHubDeviceFlow({ clientId: "client-id", scopes: ["repo"] });

    await expect(flow.start()).resolves.toEqual({
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresInSeconds: 900,
      intervalSeconds: 5,
    });
    expect(flow.poll()).toEqual({ status: "pending" });

    deviceAuth.resolve?.({
      type: "token",
      tokenType: "oauth",
      token: "github-token",
      scopes: ["repo"],
    } as OAuthAppAuthentication);
    await Promise.resolve();
    expect(flow.poll()).toMatchObject({ status: "complete" });

    flow.clear();
    expect(flow.poll()).toMatchObject({ status: "error" });
  });
});
