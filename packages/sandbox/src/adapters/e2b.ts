import { Sandbox, type SandboxInfo } from "e2b";
import type {
  CloudSandboxCreateInput,
  CloudSandboxRecord,
  E2bSandboxCreateInput,
} from "@t3tools/contracts";

import {
  providerError,
  type SandboxProviderAdapter,
  type SandboxProviderCredential,
} from "../provider.ts";

const lifecycle = {
  connect: true,
  start: false,
  stop: false,
  pause: true,
  resume: true,
  delete: true,
} as const;

function options(credential: SandboxProviderCredential) {
  return {
    apiKey: credential.apiKey,
    ...(credential.apiUrl ? { domain: credential.apiUrl } : {}),
  };
}

export function toRecord(connectionId: string, info: SandboxInfo): CloudSandboxRecord {
  return {
    providerConnectionId: connectionId as CloudSandboxRecord["providerConnectionId"],
    provider: "e2b",
    sandboxId: info.sandboxId,
    name: info.name ?? info.metadata["t3-name"] ?? info.sandboxId,
    status: info.state,
    template: info.name ?? info.templateId,
    resources: {
      cpu: info.cpuCount,
      memoryMiB: info.memoryMB,
    },
    ...(info.lifecycle
      ? {
          automaticShutdown: {
            action: info.lifecycle.onTimeout === "pause" ? ("pause" as const) : ("delete" as const),
            autoResume: info.lifecycle.autoResume,
          },
        }
      : {}),
    persistent: info.lifecycle?.onTimeout === "pause",
    associatedProject: null,
    createdAt: info.startedAt.toISOString(),
    updatedAt: info.endAt.toISOString(),
    lifecycle,
  };
}

export function createOptions(credential: SandboxProviderCredential, input: E2bSandboxCreateInput) {
  const timeoutMs = (input.timeoutMinutes ?? 60) * 60_000;
  const timeoutAction = input.ephemeral ? "kill" : (input.timeoutAction ?? "pause");
  return {
    ...options(credential),
    timeoutMs,
    secure: false,
    metadata: {
      "t3-code": "true",
      ...(input.name ? { "t3-name": input.name } : {}),
      "t3-ephemeral": input.ephemeral ? "true" : "false",
    },
    lifecycle: {
      onTimeout: timeoutAction === "delete" ? ("kill" as const) : ("pause" as const),
      ...(timeoutAction === "pause" ? { autoResume: input.autoResume ?? true } : {}),
    },
  };
}

export function makeE2bSandboxProvider(input: {
  readonly connectionId: string;
  readonly credential: SandboxProviderCredential;
}): SandboxProviderAdapter {
  const safely = async <T>(operation: string, action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (cause) {
      throw providerError("e2b", operation, cause);
    }
  };
  const getInfo = (sandboxId: string) => Sandbox.getInfo(sandboxId, options(input.credential));
  const get = (sandboxId: string) =>
    safely("get", async () => toRecord(input.connectionId, await getInfo(sandboxId)));
  const connectInstance = (sandboxId: string, timeoutMs?: number) =>
    Sandbox.connect(sandboxId, {
      ...options(input.credential),
      ...(timeoutMs ? { timeoutMs } : {}),
    });

  return {
    kind: "e2b",
    lifecycle,
    validate: () =>
      safely("validate", async () => {
        const paginator = Sandbox.list({ ...options(input.credential), limit: 1 });
        await paginator.nextItems();
      }),
    list: () =>
      safely("list", async () => {
        const result: CloudSandboxRecord[] = [];
        const paginator = Sandbox.list({
          ...options(input.credential),
          query: { metadata: { "t3-code": "true" }, state: ["running", "paused"] },
          limit: 100,
        });
        while (paginator.hasNext) {
          result.push(
            ...(await paginator.nextItems()).map((info) => toRecord(input.connectionId, info)),
          );
        }
        return result;
      }),
    get,
    create: (createInput: CloudSandboxCreateInput) =>
      safely("create", async () => {
        if (createInput.provider !== "e2b") {
          throw new Error("The E2B adapter received options for another provider.");
        }
        const create = createOptions(input.credential, createInput);
        const sandbox = createInput.template
          ? await Sandbox.create(createInput.template, create)
          : await Sandbox.create(create);
        return toRecord(input.connectionId, await sandbox.getInfo());
      }),
    connect: async (sandboxId) => {
      const sandbox = await safely("connect", () => connectInstance(sandboxId));
      return toRecord(input.connectionId, await sandbox.getInfo());
    },
    pause: async (sandboxId) => {
      const sandbox = await safely("pause", () => connectInstance(sandboxId));
      await safely("pause", () => sandbox.pause());
      return get(sandboxId);
    },
    resume: async (sandboxId) => {
      const sandbox = await safely("resume", () => connectInstance(sandboxId));
      return toRecord(input.connectionId, await sandbox.getInfo());
    },
    delete: (sandboxId) =>
      safely("delete", () => Sandbox.kill(sandboxId, options(input.credential))).then(
        () => undefined,
      ),
    runCommand: (sandboxId, command) =>
      safely("runCommand", async () => {
        const sandbox = await connectInstance(sandboxId);
        const result = await sandbox.commands.run(command.command, {
          ...(command.cwd ? { cwd: command.cwd } : {}),
          ...(command.env ? { envs: { ...command.env } } : {}),
          ...(command.timeoutMs ? { timeoutMs: command.timeoutMs } : {}),
          ...(command.background ? { background: true as const } : {}),
        });
        if ("pid" in result) {
          return { exitCode: null, stdout: "", stderr: "", processId: result.pid };
        }
        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      }),
    getEndpoint: (sandboxId, port) =>
      safely("getEndpoint", async () => {
        const sandbox = await connectInstance(sandboxId);
        return `https://${sandbox.getHost(port)}`;
      }),
  };
}
