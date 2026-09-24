import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { CloudRuntimeId, type CloudExecutionHandle } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

import { CloudProcess } from "./CloudProcess.ts";
import { makeCloudExecutionSpawner, makeCloudPtyAdapter } from "./CloudExecutionSpawner.ts";
import type { CloudRuntimeServiceShape } from "./CloudRuntimeService.ts";

const runtimeId = CloudRuntimeId.make("cloud-test");
const handle: CloudExecutionHandle = {
  schemaVersion: 1,
  runtimeId,
  kind: "e2b",
  sandboxId: "sandbox-test",
  remoteCwd: "/workspace/test",
  remoteHome: "/tmp/t3-home-sandbox-test",
  owned: true,
};

const makeArchiveSpawner = () =>
  ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: 1 as ChildProcessSpawner.ProcessId,
        exitCode: Effect.succeed(0 as ChildProcessSpawner.ExitCode),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(new Uint8Array([1, 2, 3])),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );

describe("CloudExecutionSpawner", () => {
  it.effect("moves a Codex-style command and workspace archive into the cloud sandbox", () =>
    Effect.gen(function* () {
      const remote = new CloudProcess(99);
      const commands: Array<{
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly cwd?: string;
        readonly env: Readonly<Record<string, string>>;
      }> = [];
      let archiveSeen = false;
      let prepareCalls = 0;
      const cloud = {
        prepareExecution: (input: { readonly workspaceArchive?: Uint8Array }) =>
          Effect.sync(() => {
            prepareCalls += 1;
            archiveSeen = input.workspaceArchive?.byteLength === 3;
            return handle;
          }),
        startProcess: (
          _runtimeId: CloudRuntimeId,
          _sandboxId: string,
          command: {
            readonly command: string;
            readonly args: ReadonlyArray<string>;
            readonly cwd?: string;
            readonly env: Readonly<Record<string, string>>;
          },
        ) =>
          Effect.sync(() => {
            commands.push(command);
            return remote;
          }),
      } as unknown as CloudRuntimeServiceShape;
      const transport = yield* makeCloudExecutionSpawner({
        cloud,
        localSpawner: makeArchiveSpawner(),
        runtimeId,
        instanceId: "codex-test",
        environment: {
          OPENAI_API_KEY: "host-openai-test-key",
          SERVER_SECRET: "must-not-cross-the-boundary",
        },
        providerEnvironment: [
          { name: "CUSTOM_PROVIDER_TOKEN", value: "explicit-token", sensitive: true },
          { name: "OPENAI_API_KEY", value: "explicit-openai-test-key", sensitive: true },
        ],
        sandboxPrefix: "t3-codex-test",
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

      const child = yield* transport.spawner.spawn(
        ChildProcess.make("/usr/local/bin/codex", ["app-server"], {
          cwd: process.cwd(),
          env: {
            CODEX_HOME: "/local/.codex",
            CUSTOM_PROVIDER_TOKEN: "explicit-token",
            UNRELATED_SECRET: "must-not-cross-the-boundary",
          },
        }),
      );
      remote.complete(0);
      yield* transport.spawnNode(
        ChildProcess.make("codex", ["second"], {
          cwd: process.cwd(),
          env: { CUSTOM_PROVIDER_TOKEN: "explicit-token" },
        }),
      );

      expect(archiveSeen).toBe(true);
      expect(prepareCalls).toBe(2);
      expect(commands).toHaveLength(2);
      expect(commands[0]?.command).toBe("codex");
      expect(commands[0]?.cwd).toBe("/workspace/test");
      expect(commands[0]?.env.CODEX_HOME).toBe("/tmp/t3-home-sandbox-test/.codex");
      expect(commands[0]?.env.OPENAI_API_KEY).toBe("explicit-openai-test-key");
      expect(commands[0]?.env.CUSTOM_PROVIDER_TOKEN).toBe("explicit-token");
      expect(commands[0]?.env.SERVER_SECRET).toBeUndefined();
      expect(commands[0]?.env.UNRELATED_SECRET).toBeUndefined();
      expect(Number(yield* child.exitCode)).toBe(0);
    }),
  );

  it.effect("terminates a cloud child when its owning scope closes", () =>
    Effect.gen(function* () {
      const remote = new CloudProcess(104);
      remote.setKillHandler(async () => {
        remote.complete(137, "SIGTERM");
        return true;
      });
      const cloud = {
        prepareExecution: () => Effect.succeed(handle),
        startProcess: () => Effect.succeed(remote),
      } as unknown as CloudRuntimeServiceShape;
      const transport = yield* makeCloudExecutionSpawner({
        cloud,
        localSpawner: makeArchiveSpawner(),
        runtimeId,
        instanceId: "scoped-test",
        environment: {},
        sandboxPrefix: "t3-scoped-test",
      }).pipe(Effect.provide(NodeServices.layer));

      yield* Effect.scoped(
        transport.spawner.spawn(ChildProcess.make("codex", [], { cwd: process.cwd() })),
      );

      expect(remote.killed).toBe(true);
    }),
  );

  it.effect("adapts a cloud process to the Freebuff PTY contract", () =>
    Effect.gen(function* () {
      const remote = new CloudProcess(101);
      const adapter = makeCloudPtyAdapter(() => Effect.succeed(remote));
      const cloudProcess = yield* adapter.spawn({
        shell: "freebuff",
        args: ["--trust-agents"],
        cwd: process.cwd(),
        cols: 120,
        rows: 40,
        env: {},
      });
      let output = "";
      let exitCode: number | undefined;
      cloudProcess.onData((data) => {
        output += data;
      });
      cloudProcess.onExit((event) => {
        exitCode = event.exitCode;
      });
      remote.stdout.write("ready");
      remote.complete(0);
      expect(cloudProcess.pid).toBe(101);
      expect(output).toBe("ready");
      expect(exitCode).toBe(0);
    }),
  );

  it.effect("passes terminal dimensions to the cloud PTY transport", () =>
    Effect.gen(function* () {
      let received: { readonly cols: number; readonly rows: number } | undefined;
      const adapter = makeCloudPtyAdapter((_command, pty) =>
        Effect.sync(() => {
          received = pty ? { cols: pty.cols, rows: pty.rows } : undefined;
          return new CloudProcess(103);
        }),
      );
      yield* adapter.spawn({
        shell: "freebuff",
        args: [],
        cwd: process.cwd(),
        cols: 132,
        rows: 43,
        env: {},
      });
      expect(received).toEqual({ cols: 132, rows: 43 });
    }),
  );

  it.effect("replays PTY output and completion when subscribers attach late", () =>
    Effect.gen(function* () {
      const remote = new CloudProcess(102);
      const adapter = makeCloudPtyAdapter(() => Effect.succeed(remote));
      const cloudProcess = yield* adapter.spawn({
        shell: "freebuff",
        args: [],
        cwd: process.cwd(),
        cols: 120,
        rows: 40,
        env: {},
      });
      const euro = Buffer.from("€", "utf8");
      remote.stdout.write(euro.subarray(0, 1));
      remote.stdout.write(euro.subarray(1));
      remote.complete(null, "SIGTERM");

      let output = "";
      let exitCode: number | undefined;
      cloudProcess.onData((data) => {
        output += data;
      });
      cloudProcess.onExit((event) => {
        exitCode = event.exitCode;
      });

      expect(output).toBe("€");
      expect(exitCode).toBe(1);
      expect(remote.completed).toBe(true);
      expect(yield* remote.asChildProcessHandle().isRunning).toBe(false);
    }),
  );
});
