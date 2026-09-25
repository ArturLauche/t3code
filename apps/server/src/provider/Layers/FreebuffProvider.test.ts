import { describe, expect, it } from "@effect/vitest";
import { FreebuffSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  buildInitialFreebuffProviderSnapshot,
  checkFreebuffProviderStatus,
} from "./FreebuffProvider.ts";

const settings = Schema.decodeSync(FreebuffSettings)({
  enabled: true,
  binaryPath: "freebuff",
  configDir: "",
  launchArgs: "",
});

const encoder = new TextEncoder();

const spawner = (code: number, stdout: string) =>
  ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(encoder.encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );

const check = (isAuthenticated: boolean, code = 0) =>
  checkFreebuffProviderStatus(
    settings,
    { PATH: process.env.PATH },
    process.cwd(),
    isAuthenticated,
  ).pipe(
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      spawner(code, "freebuff 0.0.195"),
    ),
  );

describe("Freebuff provider status", () => {
  it.effect("starts with an explicit unauthenticated warning while the first check runs", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialFreebuffProviderSnapshot(settings);
      expect(snapshot).toMatchObject({
        installed: true,
        status: "warning",
        auth: { status: "unknown" },
      });
    }),
  );

  it.effect("reports authenticated only when the instance has credentials", () =>
    Effect.gen(function* () {
      const authenticated = yield* check(true);
      const unauthenticated = yield* check(false);

      expect(authenticated).toMatchObject({
        status: "ready",
        auth: { status: "authenticated" },
        supportsTextGeneration: false,
      });
      expect(unauthenticated).toMatchObject({
        status: "error",
        auth: { status: "unauthenticated" },
        supportsTextGeneration: false,
      });
    }),
  );

  it.effect("keeps a failed version probe distinct from authentication", () =>
    Effect.gen(function* () {
      const snapshot = yield* check(true, 1);
      expect(snapshot).toMatchObject({
        installed: true,
        status: "error",
        auth: { status: "unknown" },
      });
    }),
  );
});
