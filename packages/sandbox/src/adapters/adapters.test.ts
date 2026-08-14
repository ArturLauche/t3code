import type { Sandbox as DaytonaSandbox } from "@daytona/sdk";
import type { SandboxInfo as E2bSandboxInfo } from "e2b";
import type { SandboxInfo as NovitaSandboxInfo } from "novita-sandbox/code-interpreter";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { daytonaCreateParams, daytonaStatus, toRecord as daytonaRecord } from "./daytona.ts";
import { createOptions as e2bOptions, toRecord as e2bRecord } from "./e2b.ts";
import { createOptions as novitaOptions, toRecord as novitaRecord } from "./novita.ts";

const connectionId = "provider:test" as never;
const startedAt = DateTime.toDate(DateTime.makeUnsafe("2026-01-02T03:04:05.000Z"));
const endAt = DateTime.toDate(DateTime.makeUnsafe("2026-01-02T04:04:05.000Z"));

function e2bInfo(state: "running" | "paused"): E2bSandboxInfo {
  return {
    sandboxId: "e2b-1",
    templateId: "base",
    name: null,
    metadata: { "t3-name": "E2B task" },
    startedAt,
    endAt,
    state,
    cpuCount: 2,
    memoryMB: 2048,
    lifecycle: { onTimeout: "pause", autoResume: true },
  } as unknown as E2bSandboxInfo;
}

function novitaInfo(state: "running" | "paused"): NovitaSandboxInfo {
  return {
    sandboxId: "novita-1",
    templateId: "base",
    name: null,
    metadata: { "t3-name": "Novita task" },
    startedAt,
    endAt,
    state,
    cpuCount: 4,
    memoryMB: 4096,
    lifecycle: { onTimeout: "kill", autoResume: false },
  } as unknown as NovitaSandboxInfo;
}

describe("sandbox provider adapters", () => {
  it("maps Daytona lifecycle states and ephemeral deletion semantics", () => {
    expect(daytonaStatus("started")).toBe("running");
    expect(daytonaStatus("pausing")).toBe("pausing");
    expect(daytonaStatus("archived")).toBe("stopped");
    expect(daytonaStatus("destroyed")).toBe("deleted");
    expect(daytonaStatus("new-provider-state")).toBe("unknown");

    const base = {
      id: "daytona-1",
      name: "Daytona task",
      state: "started",
      target: "us",
      cpu: 2,
      memory: 4,
      disk: 20,
      createdAt: startedAt.toISOString(),
      updatedAt: endAt.toISOString(),
    } as unknown as DaytonaSandbox;
    expect(
      daytonaRecord(connectionId, { ...base, autoDeleteInterval: 0 } as DaytonaSandbox),
    ).toMatchObject({ status: "running", persistent: false, region: "us" });
    expect(
      daytonaRecord(connectionId, { ...base, autoDeleteInterval: -1 } as DaytonaSandbox),
    ).toMatchObject({ persistent: true });
  });

  it("passes only supported Daytona image resources and shutdown options", () => {
    expect(
      daytonaCreateParams({
        provider: "daytona",
        providerConnectionId: connectionId,
        image: "node:22-bookworm",
        cpu: 2,
        memoryGiB: 4,
        diskGiB: 30,
        autoPauseMinutes: 20,
      }),
    ).toMatchObject({
      image: "node:22-bookworm",
      resources: { cpu: 2, memory: 4, disk: 30 },
      autoPauseInterval: 20,
    });
    expect(
      daytonaCreateParams({
        provider: "daytona",
        providerConnectionId: connectionId,
        snapshot: "snapshot-id",
        cpu: 8,
      }),
    ).toEqual({
      labels: { "t3-code": "true" },
      public: false,
      snapshot: "snapshot-id",
    });
  });

  it("maps E2B pause/resume state and lifecycle configuration", () => {
    expect(e2bRecord(connectionId, e2bInfo("paused"))).toMatchObject({
      provider: "e2b",
      status: "paused",
      persistent: true,
      lifecycle: { start: false, stop: false, pause: true, resume: true, delete: true },
    });
    expect(
      e2bOptions(
        { apiKey: "secret" },
        {
          provider: "e2b",
          providerConnectionId: connectionId,
          timeoutMinutes: 10,
          timeoutAction: "pause",
          autoResume: false,
        },
      ),
    ).toMatchObject({
      timeoutMs: 600_000,
      lifecycle: { onTimeout: "pause", autoResume: false },
      metadata: { "t3-code": "true" },
    });
  });

  it("maps Novita lifecycle state and provider-specific node placement", () => {
    expect(novitaRecord(connectionId, novitaInfo("running"))).toMatchObject({
      provider: "novita",
      status: "running",
      persistent: false,
      lifecycle: { start: false, stop: false, pause: true, resume: true, delete: true },
    });
    expect(
      novitaOptions(
        { apiKey: "secret", apiUrl: "https://api.example.test" },
        {
          provider: "novita",
          providerConnectionId: connectionId,
          nodeId: "node-7",
          timeoutMinutes: 15,
          timeoutAction: "delete",
        },
      ),
    ).toMatchObject({
      apiUrl: "https://api.example.test",
      nodeId: "node-7",
      timeoutMs: 900_000,
      lifecycle: { onTimeout: "kill" },
    });
  });
});
