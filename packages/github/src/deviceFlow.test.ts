import type { OAuthAppAuthentication } from "@octokit/auth-oauth-device";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { GitHubDeviceFlow } from "./deviceFlow.ts";

const deviceAuth = vi.hoisted(() => ({
  create: vi.fn(),
  resolve: null as null | ((authentication: OAuthAppAuthentication) => void),
}));

vi.mock("@octokit/auth-oauth-device", () => ({
  createOAuthDeviceAuth: deviceAuth.create,
}));

describe("GitHub device authorization state", () => {
  beforeEach(() => {
    deviceAuth.create.mockReset();
    deviceAuth.resolve = null;
  });

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

  it("rejects startup when OAuth fails before verification", async () => {
    deviceAuth.create.mockReturnValue(() =>
      Promise.reject(new Error("device flow unavailable")),
    );
    const flow = new GitHubDeviceFlow({ clientId: "client-id" });

    await expect(flow.start()).rejects.toThrow("device flow unavailable");
    expect(flow.poll()).toMatchObject({ status: "error" });
  });

  it("shares one startup between concurrent callers", async () => {
    let verify: ((value: unknown) => void) | null = null;
    deviceAuth.create.mockImplementation(
      (options: { onVerification: (value: unknown) => void }) => {
        verify = options.onVerification;
        return () => new Promise<OAuthAppAuthentication>(() => undefined);
      },
    );
    const flow = new GitHubDeviceFlow({ clientId: "client-id" });

    const first = flow.start();
    const second = flow.start();
    expect(deviceAuth.create).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);

    verify?.({
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    });
    await expect(first).resolves.toMatchObject({ userCode: "ABCD-1234" });
  });
});
