import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import {
  type ExecutionEnvironmentCategory,
  type GitHubCredentialInjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { redactSecrets } from "../../executionEnvironment/cloud/SandboxCredentialStore.ts";
import { GitHubConnectionError } from "./GitHubConnection.ts";

/**
 * Ephemeral GitHub credential injection for Git operations.
 *
 * The centrally stored GitHub credential is never embedded in clone URLs, never
 * written to `.git/config`, project files, shell history, or ordinary env
 * config. Instead, per-operation injection uses an ephemeral GIT_ASKPASS helper
 * script (or, for remote environments, a short-lived credential forwarded to the
 * remote T3 server / git process for the duration of the operation).
 *
 * The strategy composes with the common execution environment interface so
 * GitHub does not need separate implementations per provider:
 *
 * - `local-askpass`      — local git process; write a temp GIT_ASKPASS script.
 * - `remote-ephemeral`   — cloud/HTTP transport; forward a short-lived token.
 * - `remote-askpass`     — SSH transport; set GIT_ASKPASS on the remote git
 *                          process via the T3 SSH command channel.
 */
export class GitHubCredentialInjectionError extends Schema.TaggedErrorClass<GitHubCredentialInjectionError>()(
  "GitHubCredentialInjectionError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `GitHub credential injection failed: ${redactSecrets(this.detail)}`;
  }
}

/** A prepared ephemeral credential injection for one operation. */
export interface PreparedGitCredentialInjection {
  readonly strategy: GitHubCredentialInjection;
  /** Env overlay to merge into the git process env. */
  readonly env: NodeJS.ProcessEnv;
  /** The temp GIT_ASKPASS script path, if one was created. Clean up after use. */
  readonly askpassScriptPath: string | null;
  /** For remote strategies, the short-lived credential to forward. */
  readonly ephemeralCredential: string | null;
}

const ASKPASS_HEADER = "#!/usr/bin/env node\n";

/**
 * Write an ephemeral GIT_ASKPASS helper that prints the GitHub token only when
 * git asks for it, then returns the env overlay. The script is mode 0700, lives
 * in the OS temp dir under a random name, and is removed by {@link cleanup}.
 *
 * The credential is never placed in a URL or `.git/config`; git calls the helper
 * with the prompt and receives the token on stdout. We disable git's terminal
 * prompt and GCM interactivity so a missing credential fails fast instead of
 * hanging or invoking a system credential helper that might persist it.
 */
export const prepareLocalAskpass = Effect.fn("GitHubCredentialInjection.prepareLocalAskpass")(
  function* (input: { readonly credential: string; readonly host: string }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scriptId = NodeCrypto.randomUUID();
    const tmpDir = NodeOs.tmpdir();
    const scriptPath = NodePath.join(tmpDir, `t3-gh-askpass-${scriptId}.cjs`);

    // The helper only answers the GitHub host's https prompt. Other prompts get
    // an empty response so the credential is never leaked to a different host.
    const script = [
      ASKPASS_HEADER,
      `"use strict";`,
      `const credential = ${JSON.stringify(input.credential)};`,
      `const host = ${JSON.stringify(input.host)};`,
      `const prompt = process.argv[2] || "";`,
      `// Only answer Username/Password prompts for the configured host.`,
      `if (prompt.toLowerCase().includes(host)) {`,
      `  if (/password/i.test(prompt)) process.stdout.write(credential);`,
      `  else if (/username/i.test(prompt)) process.stdout.write("x-access-token");`,
      `}`,
      ``,
    ].join("\n");

    yield* fileSystem.writeFileString(scriptPath, script).pipe(
      Effect.mapError(
        (cause) =>
          new GitHubCredentialInjectionError({
            operation: "writeAskpass",
            detail: "Could not write the ephemeral GIT_ASKPASS helper.",
            cause: cause as never,
          }),
      ),
    );
    // chmod 0700 so the helper is executable and owner-only.
    yield* Effect.try(() => NodeFs.chmodSync(scriptPath, 0o700)).pipe(
      Effect.mapError(
        (cause) =>
          new GitHubCredentialInjectionError({
            operation: "chmodAskpass",
            detail: "Could not make the GIT_ASKPASS helper executable.",
            cause: cause as never,
          }),
      ),
    );

    const env: NodeJS.ProcessEnv = {
      GIT_ASKPASS: scriptPath,
      GIT_TERMINAL_PROMPT: "0",
      SSH_ASKPASS: "",
      SSH_ASKPASS_REQUIRE: "never",
      GCM_INTERACTIVE: "never",
      // git-credential helpers can persist credentials; disable them for this op.
      GIT_CONFIG_NOSYSTEM: "1",
    };

    return {
      strategy: "local-askpass" as const,
      env,
      askpassScriptPath: scriptPath,
      ephemeralCredential: null,
    } satisfies PreparedGitCredentialInjection;
  },
);

/**
 * Prepare a remote credential injection. The credential is forwarded to the
 * remote T3 server / git process for the duration of one operation and never
 * persisted on the remote host. The caller is responsible for invoking the
 * remote git process with this env and discarding the credential afterward.
 */
export const prepareRemoteEphemeral = Effect.fn("GitHubCredentialInjection.prepareRemoteEphemeral")(
  function* (input: { readonly credential: string }) {
    return {
      strategy: "remote-ephemeral" as const,
      env: {} as NodeJS.ProcessEnv,
      askpassScriptPath: null,
      ephemeralCredential: input.credential,
    } satisfies PreparedGitCredentialInjection;
  },
);

/**
 * Prepare an SSH-transport remote askpass. The remote git process gets a
 * GIT_ASKPASS env pointing at a helper the remote T3 server materializes
 * ephemerally; the token is forwarded over the T3 SSH command channel, never
 * written to the remote user's global git config.
 */
export const prepareRemoteAskpass = Effect.fn("GitHubCredentialInjection.prepareRemoteAskpass")(
  function* (input: { readonly credential: string }) {
    return {
      strategy: "remote-askpass" as const,
      env: {
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "never",
      } as NodeJS.ProcessEnv,
      askpassScriptPath: null,
      ephemeralCredential: input.credential,
    } satisfies PreparedGitCredentialInjection;
  },
);

/** Resolve the injection strategy for an environment category. */
export function resolveInjectionStrategy(
  category: ExecutionEnvironmentCategory,
): GitHubCredentialInjection {
  switch (category) {
    case "local":
      return "local-askpass";
    case "ssh-remote":
      return "remote-askpass";
    case "cloud":
      // Cloud providers that expose SSH (Daytona) route through remote-askpass;
      // HTTP/WebSocket providers (E2B/Novita) use remote-ephemeral. The cloud
      // execution environment layer selects based on the provider transport.
      return "remote-ephemeral";
  }
}

/** Prepare credential injection for a given category. */
export const prepareCredentialInjection = Effect.fn("GitHubCredentialInjection.prepare")(
  function* (input: {
    readonly category: ExecutionEnvironmentCategory;
    readonly credential: string;
    readonly host: string;
  }) {
    const strategy = resolveInjectionStrategy(input.category);
    switch (strategy) {
      case "local-askpass":
        return yield* prepareLocalAskpass(input);
      case "remote-ephemeral":
        return yield* prepareRemoteEphemeral(input);
      case "remote-askpass":
        return yield* prepareRemoteAskpass(input);
    }
  },
);

/** Remove the ephemeral GIT_ASKPASS helper if one was created. Always succeeds. */
export const cleanup = Effect.fn("GitHubCredentialInjection.cleanup")(function* (
  prepared: PreparedGitCredentialInjection,
) {
  if (prepared.askpassScriptPath === null) {
    return;
  }
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.remove(prepared.askpassScriptPath, { force: true }).pipe(Effect.ignore);
});

/**
 * Run a git operation with an injected credential, ensuring cleanup. The
 * callback receives the prepared env overlay to merge into the git process env.
 */
export const withGitCredential = <A, E, R>(
  input: {
    readonly category: ExecutionEnvironmentCategory;
    readonly credential: string;
    readonly host: string;
  },
  use: (prepared: PreparedGitCredentialInjection) => Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E | GitHubCredentialInjectionError | GitHubConnectionError,
  R | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const prepared = yield* prepareCredentialInjection(input);
    return yield* use(prepared).pipe(Effect.ensuring(cleanup(prepared)));
  });
