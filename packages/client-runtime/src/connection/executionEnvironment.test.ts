import { describe, expect, it } from "vite-plus/test";

import {
  CloudSandboxConnectionTarget,
  PrimaryConnectionTarget,
  SshConnectionTarget,
} from "./model.ts";
import {
  executionEnvironmentCapabilities,
  executionEnvironmentCategory,
} from "./executionEnvironment.ts";

const environmentId = "env_test" as never;

describe("execution environment view", () => {
  it("classifies existing local and SSH targets without changing their transports", () => {
    const local = new PrimaryConnectionTarget({
      environmentId,
      label: "This device",
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773",
    });
    const ssh = new SshConnectionTarget({
      environmentId,
      label: "Build host",
      connectionId: "ssh",
    });

    expect(executionEnvironmentCategory(local)).toBe("local");
    expect(executionEnvironmentCategory(ssh)).toBe("ssh-remote");
    expect(executionEnvironmentCapabilities(ssh)).toMatchObject({
      commandExecution: true,
      filesystem: true,
      gitCredentials: true,
      pause: false,
      delete: false,
    });
  });

  it("projects provider lifecycle support into the common capability contract", () => {
    const sandbox = new CloudSandboxConnectionTarget({
      environmentId,
      label: "Task sandbox",
      connectionId: "sandbox:test",
    });
    const capabilities = executionEnvironmentCapabilities(sandbox, {
      connect: true,
      start: false,
      stop: false,
      pause: true,
      resume: true,
      delete: true,
    });

    expect(executionEnvironmentCategory(sandbox)).toBe("cloud-sandbox");
    expect(capabilities).toMatchObject({
      create: true,
      shutdown: false,
      pause: true,
      resume: true,
      delete: true,
    });
  });
});
