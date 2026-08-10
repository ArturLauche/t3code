import { Daytona, type Sandbox } from "@daytona/sdk";
import type {
  CloudSandboxCreateInput,
  CloudSandboxRecord,
  DaytonaSandboxCreateInput,
} from "@t3tools/contracts";

import {
  providerError,
  type SandboxProviderAdapter,
  type SandboxProviderCredential,
} from "../provider.ts";

const DAYTONA_SSH_HOST = "ssh.app.daytona.io";
const DAYTONA_SSH_PORT = 22;

export function daytonaStatus(state: string | undefined): CloudSandboxRecord["status"] {
  switch (state) {
    case "creating":
    case "pending_build":
    case "building_snapshot":
    case "pulling_snapshot":
      return "creating";
    case "starting":
    case "restoring":
    case "resuming":
      return "starting";
    case "started":
      return "running";
    case "stopping":
    case "archiving":
      return "stopping";
    case "stopped":
    case "archived":
      return "stopped";
    case "pausing":
      return "pausing";
    case "paused":
      return "paused";
    case "destroying":
      return "deleting";
    case "destroyed":
      return "deleted";
    case "error":
    case "build_failed":
      return "error";
    default:
      return "unknown";
  }
}

export function toRecord(connectionId: string, sandbox: Sandbox): CloudSandboxRecord {
  const createdAt = sandbox.createdAt ?? sandbox.updatedAt ?? "1970-01-01T00:00:00.000Z";
  const updatedAt = sandbox.updatedAt ?? createdAt;
  const automaticShutdown =
    sandbox.autoDeleteInterval !== undefined && sandbox.autoDeleteInterval >= 0
      ? {
          action: "delete" as const,
          ...(sandbox.autoDeleteInterval > 0
            ? { timeoutMinutes: sandbox.autoDeleteInterval }
            : {}),
        }
      : sandbox.autoPauseInterval !== undefined && sandbox.autoPauseInterval > 0
        ? { action: "pause" as const, timeoutMinutes: sandbox.autoPauseInterval }
        : sandbox.autoStopInterval !== undefined && sandbox.autoStopInterval > 0
          ? { action: "stop" as const, timeoutMinutes: sandbox.autoStopInterval }
          : {};
  return {
    providerConnectionId: connectionId as CloudSandboxRecord["providerConnectionId"],
    provider: "daytona",
    sandboxId: sandbox.id,
    name: sandbox.name || sandbox.id,
    status: daytonaStatus(sandbox.state),
    ...(sandbox.target ? { region: sandbox.target } : {}),
    ...(sandbox.snapshot ? { template: sandbox.snapshot } : {}),
    resources: {
      cpu: sandbox.cpu,
      memoryMiB: Math.round(sandbox.memory * 1024),
      diskGiB: sandbox.disk,
    },
    automaticShutdown,
    // Daytona uses a negative value (or omission) to disable deletion; zero
    // means an ephemeral sandbox that is deleted as soon as it stops.
    persistent: sandbox.autoDeleteInterval === undefined || sandbox.autoDeleteInterval < 0,
    associatedProject: null,
    createdAt,
    updatedAt,
    lifecycle: {
      connect: true,
      start: true,
      stop: true,
      pause: true,
      resume: true,
      delete: true,
    },
  };
}

export function daytonaCreateParams(input: DaytonaSandboxCreateInput) {
  const common = {
    ...(input.name ? { name: input.name } : {}),
    labels: { "t3-code": "true" },
    public: false,
    ...(input.ephemeral === undefined ? {} : { ephemeral: input.ephemeral }),
    ...(input.autoStopMinutes === undefined ? {} : { autoStopInterval: input.autoStopMinutes }),
    ...(input.autoPauseMinutes === undefined ? {} : { autoPauseInterval: input.autoPauseMinutes }),
    ...(input.autoDeleteMinutes === undefined
      ? {}
      : { autoDeleteInterval: input.autoDeleteMinutes }),
    ...(input.ttlMinutes === undefined ? {} : { ttlMinutes: input.ttlMinutes }),
  };
  if (input.image) {
    return {
      ...common,
      image: input.image,
      resources: {
        ...(input.cpu === undefined ? {} : { cpu: input.cpu }),
        ...(input.memoryGiB === undefined ? {} : { memory: input.memoryGiB }),
        ...(input.diskGiB === undefined ? {} : { disk: input.diskGiB }),
      },
    };
  }
  return { ...common, ...(input.snapshot ? { snapshot: input.snapshot } : {}) };
}

export function makeDaytonaSandboxProvider(input: {
  readonly connectionId: string;
  readonly credential: SandboxProviderCredential;
}): SandboxProviderAdapter {
  const makeClient = (target?: string) =>
    new Daytona({
      apiKey: input.credential.apiKey,
      ...(input.credential.apiUrl ? { apiUrl: input.credential.apiUrl } : {}),
      ...(target ? { target } : {}),
      otelEnabled: false,
    });
  const lifecycle = {
    connect: true,
    start: true,
    stop: true,
    pause: true,
    resume: true,
    delete: true,
  } as const;
  const safely = async <T>(operation: string, action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (cause) {
      throw providerError("daytona", operation, cause);
    }
  };
  const getSandbox = (sandboxId: string) => makeClient().get(sandboxId);
  const get = (sandboxId: string) =>
    safely("get", async () => toRecord(input.connectionId, await getSandbox(sandboxId)));

  return {
    kind: "daytona",
    lifecycle,
    validate: () =>
      safely("validate", async () => {
        const iterator = makeClient().list({ limit: 1 });
        await iterator.next();
      }),
    list: () =>
      safely("list", async () => {
        const records: CloudSandboxRecord[] = [];
        for await (const sandbox of makeClient().list({ labels: { "t3-code": "true" } })) {
          records.push(toRecord(input.connectionId, sandbox));
        }
        return records;
      }),
    get,
    create: (createInput: CloudSandboxCreateInput) =>
      safely("create", async () => {
        if (createInput.provider !== "daytona") {
          throw new Error("The Daytona adapter received options for another provider.");
        }
        const client = makeClient(createInput.region);
        const sandbox = await client.create(daytonaCreateParams(createInput));
        return toRecord(input.connectionId, sandbox);
      }),
    connect: async (sandboxId) => {
      const sandbox = await safely("connect", () => getSandbox(sandboxId));
      if (sandbox.state !== "started") {
        await safely("start", () => makeClient().start(sandbox));
        await sandbox.refreshData();
      }
      return toRecord(input.connectionId, sandbox);
    },
    start: async (sandboxId) => {
      const sandbox = await safely("start", () => getSandbox(sandboxId));
      await safely("start", () => makeClient().start(sandbox));
      await sandbox.refreshData();
      return toRecord(input.connectionId, sandbox);
    },
    stop: async (sandboxId) => {
      const sandbox = await safely("stop", () => getSandbox(sandboxId));
      await safely("stop", () => makeClient().stop(sandbox));
      await sandbox.refreshData();
      return toRecord(input.connectionId, sandbox);
    },
    pause: async (sandboxId) => {
      const sandbox = await safely("pause", () => getSandbox(sandboxId));
      await safely("pause", () => sandbox.pause());
      await sandbox.refreshData();
      return toRecord(input.connectionId, sandbox);
    },
    resume: async (sandboxId) => {
      const sandbox = await safely("resume", () => getSandbox(sandboxId));
      await safely("resume", () => makeClient().start(sandbox));
      await sandbox.refreshData();
      return toRecord(input.connectionId, sandbox);
    },
    delete: async (sandboxId) => {
      const sandbox = await safely("delete", () => getSandbox(sandboxId));
      await safely("delete", () => sandbox.delete(60, true));
    },
    createSshAccess: async (sandboxId, expiresInMinutes = 15) => {
      const sandbox = await safely("createSshAccess", () => getSandbox(sandboxId));
      const access = await safely("createSshAccess", () =>
        sandbox.createSshAccess(expiresInMinutes),
      );
      return {
        token: access.token,
        hostname: DAYTONA_SSH_HOST,
        username: access.token,
        port: DAYTONA_SSH_PORT,
        expiresAt: access.expiresAt.toISOString(),
        revoke: () => sandbox.revokeSshAccess(access.token),
      };
    },
  };
}
