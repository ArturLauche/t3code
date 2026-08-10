import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const PERSISTED_GITHUB_TOKEN = "github-token";
const DEFAULT_EPHEMERAL_TTL_SECONDS = 15 * 60;

interface EphemeralCredential {
  readonly token: string;
  readonly expiresAtEpochMs: number;
}

export class GitHubCredentialBrokerError extends Schema.TaggedErrorClass<GitHubCredentialBrokerError>()(
  "GitHubCredentialBrokerError",
  { operation: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `GitHub credential broker failed during ${this.operation}: ${this.detail}`;
  }
}

export class GitHubCredentialBroker extends Context.Service<
  GitHubCredentialBroker,
  {
    readonly injectEphemeral: (input: {
      readonly token: string;
      readonly ttlSeconds?: number;
    }) => Effect.Effect<void>;
    readonly clearEphemeral: Effect.Effect<void>;
    readonly getToken: Effect.Effect<Option.Option<string>, GitHubCredentialBrokerError>;
    readonly setPersistentToken: (
      token: string,
    ) => Effect.Effect<void, GitHubCredentialBrokerError>;
    readonly clearPersistentToken: Effect.Effect<void, GitHubCredentialBrokerError>;
    readonly processEnvironment: Effect.Effect<
      Option.Option<NodeJS.ProcessEnv>,
      GitHubCredentialBrokerError
    >;
  }
>()("t3/sourceControl/GitHubCredentialBroker") {}

const askPassScript = `#!/usr/bin/env node
const prompt = String(process.argv[2] || "").toLowerCase();
process.stdout.write(prompt.includes("username") ? "x-access-token" : (process.env.T3_GITHUB_TOKEN || ""));
`;

const windowsAskPassScript = `@echo off\r\nnode "%~dp0github-askpass.js" %*\r\n`;

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const platform = yield* HostProcessPlatform;
  const ephemeral = yield* Ref.make(Option.none<EphemeralCredential>());
  const helperDir = path.join(config.stateDir, "credential-helpers");
  const scriptPath = path.join(helperDir, "github-askpass.js");
  const windowsScriptPath = path.join(helperDir, "github-askpass.cmd");

  yield* fileSystem.makeDirectory(helperDir, { recursive: true });
  yield* fileSystem.writeFileString(scriptPath, askPassScript);
  yield* fileSystem.chmod(scriptPath, 0o700);
  yield* fileSystem.writeFileString(windowsScriptPath, windowsAskPassScript);

  const error = (operation: string, cause: unknown) =>
    new GitHubCredentialBrokerError({
      operation,
      detail: cause instanceof Error ? cause.message : String(cause),
    });

  const getToken = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const current = yield* Ref.get(ephemeral);
    if (Option.isSome(current)) {
      if (now < current.value.expiresAtEpochMs) return Option.some(current.value.token);
      yield* Ref.set(ephemeral, Option.none());
    }
    return yield* secrets.get(PERSISTED_GITHUB_TOKEN).pipe(
      Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
      Effect.mapError((cause) => error("read-persisted-token", cause)),
    );
  });

  return GitHubCredentialBroker.of({
    injectEphemeral: (input) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Ref.set(
            ephemeral,
            Option.some({
              token: input.token,
              expiresAtEpochMs:
                now + Math.max(1, input.ttlSeconds ?? DEFAULT_EPHEMERAL_TTL_SECONDS) * 1_000,
            }),
          ),
        ),
      ),
    clearEphemeral: Ref.set(ephemeral, Option.none()),
    getToken,
    setPersistentToken: (token) =>
      secrets
        .set(PERSISTED_GITHUB_TOKEN, new TextEncoder().encode(token))
        .pipe(Effect.mapError((cause) => error("persist-token", cause))),
    clearPersistentToken: secrets
      .remove(PERSISTED_GITHUB_TOKEN)
      .pipe(Effect.mapError((cause) => error("clear-token", cause))),
    processEnvironment: getToken.pipe(
      Effect.map(
        Option.map((token) => ({
          GH_TOKEN: token,
          GITHUB_TOKEN: token,
          T3_GITHUB_TOKEN: token,
          GIT_ASKPASS: platform === "win32" ? windowsScriptPath : scriptPath,
          GIT_TERMINAL_PROMPT: "0",
        })),
      ),
    ),
  });
});

export const layer = Layer.effect(GitHubCredentialBroker, make);
