import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { withOpenCodeProviderConfig } from "@t3tools/shared/openCodeProviderConfig";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as OpenCodeServerLedger from "./OpenCodeServerLedger.ts";

describe("resolveOpenCodeConfigContent", () => {
  it("carries provider config merged into the document the server is spawned with", () => {
    // The driver hands OpenCode its config through the environment; these two
    // halves must agree on the variable or a configured provider is ignored.
    const environment = withOpenCodeProviderConfig({
      environment: { OPENCODE_CONFIG_CONTENT: '{"model":"anthropic/claude-sonnet-5"}' },
      entries: [
        {
          providerId: "local",
          env: [],
          apiKey: "sk-local",
          apiKeyRedacted: false,
          models: [{ modelId: "vendor/large" }],
        },
      ],
    });
    expect(OpenCodeRuntime.resolveOpenCodeConfigContent(environment, {})).toBe(
      environment.OPENCODE_CONFIG_CONTENT,
    );
    expect(JSON.parse(environment.OPENCODE_CONFIG_CONTENT ?? "{}")).toEqual({
      model: "anthropic/claude-sonnet-5",
      provider: {
        local: { options: { apiKey: "sk-local" }, models: { "vendor/large": {} } },
      },
    });
  });
});

describe("resolveOpenCodeServerPassword", () => {
  it("uses the settings password when local settings and environment differ", () => {
    expect(
      OpenCodeRuntime.resolveOpenCodeServerPassword(
        {
          external: false,
          serverPassword: "settings-password",
          environment: { OPENCODE_SERVER_PASSWORD: "environment-password" },
        },
        {},
      ),
    ).toBe("settings-password");
  });

  it("does not send an inherited local password to an external server", () => {
    expect(
      OpenCodeRuntime.resolveOpenCodeServerPassword(
        { external: true, environment: { OPENCODE_SERVER_PASSWORD: "local-secret" } },
        { OPENCODE_SERVER_PASSWORD: "inherited-secret" },
      ),
    ).toBeUndefined();
  });
});

describe("startOpenCodeServerProcess", () => {
  it.effect("gives a server started without a configured password a generated one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-password-" });
      const binaryPath = path.join(tempDir, "opencode");
      const receivedPath = path.join(tempDir, "received");
      yield* fs.writeFileString(
        binaryPath,
        [
          "#!/bin/sh",
          `printf %s "$OPENCODE_SERVER_PASSWORD" > "${receivedPath}"`,
          'echo "opencode server listening on http://127.0.0.1:4096"',
          "",
        ].join("\n"),
      );
      yield* fs.chmod(binaryPath, 0o755);

      const server = yield* OpenCodeRuntime.OpenCodeRuntime.pipe(
        Effect.flatMap((runtime) =>
          runtime.startOpenCodeServerProcess({
            binaryPath,
            directory: tempDir,
            port: 4096,
            environment: { PATH: process.env.PATH, OPENCODE_SERVER_PASSWORD: "" },
            verify: () => Effect.succeed("1.0.0"),
          }),
        ),
        Effect.provide(
          OpenCodeRuntime.layer.pipe(
            Layer.provide(
              Layer.succeed(
                OpenCodeServerLedger.OpenCodeServerLedger,
                OpenCodeServerLedger.OpenCodeServerLedger.of({
                  track: () => Effect.succeed(Effect.void),
                }),
              ),
            ),
          ),
        ),
      );

      expect(server.serverPassword).toMatch(/^[\w-]{43}$/);
      expect(yield* fs.readFileString(receivedPath)).toBe(server.serverPassword);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
