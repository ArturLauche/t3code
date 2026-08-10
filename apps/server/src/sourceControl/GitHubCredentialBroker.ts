import * as NodeCrypto from "node:crypto";

import { EnvironmentAuthenticatedPrincipal } from "@t3tools/contracts";
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

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";

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
      readonly sessionId: string;
      readonly token: string;
      readonly ttlSeconds?: number;
    }) => Effect.Effect<void>;
    readonly clearEphemeral: (sessionId: string) => Effect.Effect<void>;
    readonly getToken: Effect.Effect<Option.Option<string>, GitHubCredentialBrokerError>;
    readonly setPersistentToken: (
      token: string,
    ) => Effect.Effect<void, GitHubCredentialBrokerError>;
    readonly clearPersistentToken: Effect.Effect<void, GitHubCredentialBrokerError>;
    readonly processEnvironment: Effect.Effect<
      Option.Option<NodeJS.ProcessEnv>,
      GitHubCredentialBrokerError
    >;
    readonly cliEnvironment: Effect.Effect<
      Option.Option<NodeJS.ProcessEnv>,
      GitHubCredentialBrokerError
    >;
  }
>()("t3/sourceControl/GitHubCredentialBroker") {}

const askPassScript = `const fs = require("node:fs");
const prompt = String(process.argv[2] || "");
const match = prompt.match(/https:\\/\\/[^'"\\s)]+/i);
if (!match) process.exit(0);
let remote;
try { remote = new URL(match[0]); } catch { process.exit(0); }
if (remote.protocol !== "https:" || remote.hostname.toLowerCase() !== "github.com") process.exit(0);
if (/username/i.test(prompt)) {
  process.stdout.write("x-access-token");
  process.exit(0);
}
if (!/password/i.test(prompt)) process.exit(0);
try { process.stdout.write(fs.readFileSync(process.env.T3_GITHUB_TOKEN_FILE || "", "utf8")); } catch {}
`;

const posixAskPassScript = `#!/bin/sh
exec "$T3_GITHUB_NODE_EXECUTABLE" "$T3_GITHUB_ASKPASS_SCRIPT" "$@"
`;
const windowsAskPassScript = `@echo off\r\n"%T3_GITHUB_NODE_EXECUTABLE%" "%T3_GITHUB_ASKPASS_SCRIPT%" %*\r\n`;

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const platform = yield* HostProcessPlatform;
  const ephemeral = yield* Ref.make(new Map<string, EphemeralCredential>());
  const helperDir = path.join(config.stateDir, "credential-helpers");
  const tokenDir = path.join(helperDir, "tokens");
  const emptyHooksDir = path.join(helperDir, "empty-hooks");
  const scriptPath = path.join(helperDir, "github-askpass.js");
  const posixScriptPath = path.join(helperDir, "github-askpass.sh");
  const windowsScriptPath = path.join(helperDir, "github-askpass.cmd");

  yield* fileSystem.makeDirectory(tokenDir, { recursive: true });
  yield* fileSystem.makeDirectory(emptyHooksDir, { recursive: true });
  yield* fileSystem.chmod(helperDir, 0o700);
  yield* fileSystem.chmod(tokenDir, 0o700);
  yield* fileSystem.chmod(emptyHooksDir, 0o700);
  yield* fileSystem.writeFileString(scriptPath, askPassScript);
  yield* fileSystem.writeFileString(posixScriptPath, posixAskPassScript);
  yield* fileSystem.writeFileString(windowsScriptPath, windowsAskPassScript);
  yield* fileSystem.chmod(scriptPath, 0o700);
  yield* fileSystem.chmod(posixScriptPath, 0o700);

  const error = (operation: string, cause: unknown) =>
    new GitHubCredentialBrokerError({
      operation,
      detail: cause instanceof Error ? cause.message : String(cause),
    });

  const currentSessionId = Effect.serviceOption(EnvironmentAuthenticatedPrincipal).pipe(
    Effect.map(Option.map((principal) => String(principal.sessionId))),
  );

  const getTokenForSession = (sessionId: Option.Option<string>) =>
    Effect.gen(function* () {
      if (Option.isSome(sessionId)) {
        const now = yield* Clock.currentTimeMillis;
        const current = yield* Ref.get(ephemeral);
        const credential = current.get(sessionId.value);
        if (credential !== undefined) {
          if (now < credential.expiresAtEpochMs) return Option.some(credential.token);
          yield* Ref.update(ephemeral, (entries) => {
            const next = new Map(entries);
            next.delete(sessionId.value);
            return next;
          });
        }
      }
      return yield* secrets.get(PERSISTED_GITHUB_TOKEN).pipe(
        Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
        Effect.mapError((cause) => error("read-persisted-token", cause)),
      );
    });

  const getToken = currentSessionId.pipe(Effect.flatMap(getTokenForSession));

  const tokenFileFor = (sessionId: Option.Option<string>) => {
    const key = Option.getOrElse(sessionId, () => "persistent");
    const digest = NodeCrypto.createHash("sha256").update(key).digest("hex");
    return path.join(tokenDir, `${digest}.token`);
  };

  const gitHardeningEnvironment = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: emptyHooksDir,
  } satisfies NodeJS.ProcessEnv;

  const processEnvironment = Effect.gen(function* () {
    const sessionId = yield* currentSessionId;
    const token = yield* getTokenForSession(sessionId);
    if (Option.isNone(token)) return Option.none<NodeJS.ProcessEnv>();
    const tokenFile = tokenFileFor(sessionId);
    yield* fileSystem
      .writeFileString(tokenFile, token.value)
      .pipe(Effect.mapError((cause) => error("write-token-file", cause)));
    yield* fileSystem
      .chmod(tokenFile, 0o600)
      .pipe(Effect.mapError((cause) => error("protect-token-file", cause)));
    return Option.some<NodeJS.ProcessEnv>({
      ...gitHardeningEnvironment,
      GIT_ASKPASS: platform === "win32" ? windowsScriptPath : posixScriptPath,
      GIT_ASKPASS_REQUIRE: "force",
      GIT_TERMINAL_PROMPT: "0",
      T3_GITHUB_NODE_EXECUTABLE: process.execPath,
      T3_GITHUB_ASKPASS_SCRIPT: scriptPath,
      T3_GITHUB_TOKEN_FILE: tokenFile,
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    });
  });

  return GitHubCredentialBroker.of({
    injectEphemeral: (input) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          Ref.update(ephemeral, (entries) => {
            const next = new Map(entries);
            next.set(input.sessionId, {
              token: input.token,
              expiresAtEpochMs:
                now + Math.max(1, input.ttlSeconds ?? DEFAULT_EPHEMERAL_TTL_SECONDS) * 1_000,
            });
            return next;
          }),
        ),
      ),
    clearEphemeral: (sessionId) =>
      Ref.update(ephemeral, (entries) => {
        const next = new Map(entries);
        next.delete(sessionId);
        return next;
      }).pipe(
        Effect.andThen(fileSystem.remove(tokenFileFor(Option.some(sessionId))).pipe(Effect.ignore)),
      ),
    getToken,
    setPersistentToken: (token) =>
      secrets
        .set(PERSISTED_GITHUB_TOKEN, new TextEncoder().encode(token))
        .pipe(Effect.mapError((cause) => error("persist-token", cause))),
    clearPersistentToken: secrets.remove(PERSISTED_GITHUB_TOKEN).pipe(
      Effect.mapError((cause) => error("clear-token", cause)),
      Effect.andThen(fileSystem.remove(tokenFileFor(Option.none())).pipe(Effect.ignore)),
    ),
    processEnvironment,
    cliEnvironment: getToken.pipe(
      Effect.map(
        Option.map((token) => ({
          ...gitHardeningEnvironment,
          GH_TOKEN: token,
        })),
      ),
    ),
  });
});

export const layer = Layer.effect(GitHubCredentialBroker, make);
