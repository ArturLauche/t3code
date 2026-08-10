// @effect-diagnostics globalDate:off -- SDK mocks must construct native Date values before imports initialize.
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const sdk = vi.hoisted(() => {
  const info = {
    sandboxId: "sandbox-1",
    templateId: "template-1",
    name: "E2B task",
    metadata: { "t3-code": "true" },
    startedAt: new Date("2026-01-01T00:00:00Z"),
    endAt: new Date("2026-01-01T01:00:00Z"),
    state: "running",
    cpuCount: 2,
    memoryMB: 1024,
    lifecycle: { onTimeout: "pause", autoResume: true },
  };
  return {
    info,
    create: vi.fn(),
    connect: vi.fn(),
    kill: vi.fn(),
    list: vi.fn(),
    pause: vi.fn(),
    run: vi.fn(),
    getHost: vi.fn(),
    getInfo: vi.fn(),
  };
});

vi.mock("e2b", () => ({
  Sandbox: Object.assign(function MockSandbox() {}, {
    create: sdk.create,
    connect: sdk.connect,
    kill: sdk.kill,
    list: sdk.list,
    getInfo: sdk.getInfo,
  }),
}));

import { makeE2bSandboxProvider } from "./e2b.ts";

function instance() {
  return {
    getInfo: vi.fn(async () => sdk.info),
    pause: sdk.pause,
    commands: { run: sdk.run },
    getHost: sdk.getHost,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sdk.create.mockResolvedValue(instance());
  sdk.connect.mockResolvedValue(instance());
  sdk.kill.mockResolvedValue(undefined);
  sdk.pause.mockResolvedValue(undefined);
  sdk.run.mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
  sdk.getHost.mockReturnValue("3773-sandbox.example.test");
  sdk.getInfo.mockResolvedValue(sdk.info);
  sdk.list.mockImplementation(() => {
    let returned = false;
    return {
      get hasNext() {
        return !returned;
      },
      nextItems: vi.fn(async () => {
        returned = true;
        return [sdk.info];
      }),
    };
  });
});

describe("E2B provider API adapter", () => {
  it("uses the official lifecycle, command, and endpoint APIs behind the common contract", async () => {
    const adapter = makeE2bSandboxProvider({
      connectionId: "e2b:test",
      credential: { apiKey: "e2b-secret" },
    });

    await adapter.validate();
    await expect(adapter.list()).resolves.toEqual([
      expect.objectContaining({ provider: "e2b", sandboxId: "sandbox-1", status: "running" }),
    ]);
    await expect(
      adapter.create({
        provider: "e2b",
        providerConnectionId: "e2b:test" as never,
        template: "node-template",
        timeoutMinutes: 10,
      }),
    ).resolves.toMatchObject({ sandboxId: "sandbox-1" });
    expect(sdk.create).toHaveBeenCalledWith(
      "node-template",
      expect.objectContaining({ apiKey: "e2b-secret", timeoutMs: 600_000 }),
    );

    await adapter.pause?.("sandbox-1");
    expect(sdk.pause).toHaveBeenCalledOnce();
    await expect(
      adapter.runCommand?.("sandbox-1", { command: "pwd", cwd: "/workspace" }),
    ).resolves.toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
    expect(sdk.run).toHaveBeenCalledWith("pwd", expect.objectContaining({ cwd: "/workspace" }));
    await expect(adapter.getEndpoint?.("sandbox-1", 3773)).resolves.toBe(
      "https://3773-sandbox.example.test",
    );
    await adapter.delete("sandbox-1");
    expect(sdk.kill).toHaveBeenCalledWith("sandbox-1", { apiKey: "e2b-secret" });
  });

  it("rejects provider-mismatched creation input before making an SDK request", async () => {
    const adapter = makeE2bSandboxProvider({
      connectionId: "e2b:test",
      credential: { apiKey: "e2b-secret" },
    });
    await expect(
      adapter.create({
        provider: "daytona",
        providerConnectionId: "e2b:test" as never,
      }),
    ).rejects.toThrow("options for another provider");
    expect(sdk.create).not.toHaveBeenCalled();
  });
});
