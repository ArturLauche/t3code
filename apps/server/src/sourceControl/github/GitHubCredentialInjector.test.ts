import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFs from "node:fs";

import { maskSecret, redactSecrets } from "../../executionEnvironment/cloud/SandboxCredentialStore.ts";
import {
  cleanup,
  prepareCredentialInjection,
  resolveInjectionStrategy,
} from "./GitHubCredentialInjector.ts";

const FsLayer = NodeServices.layer;

describe("maskSecret", () => {
  it("masks all but the last 4 characters", () => {
    expect(maskSecret("ghp_abcdefghijklmnopqrstuvwxyz123456")).toBe("••••3456");
  });

  it("fully masks short secrets", () => {
    expect(maskSecret("ab")).toBe("••••");
  });
});

describe("redactSecrets", () => {
  it("redacts GitHub PATs", () => {
    const text = "Using token ghp_abcdefghijklmnopqrstuvwxyz123456 for clone";
    expect(redactSecrets(text)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
  });

  it("redacts fine-grained GitHub tokens", () => {
    const text = "github_pat_11ABCDEFGabcdefghijklmnopqrstuvwxyz12345";
    expect(redactSecrets(text)).not.toContain("github_pat_");
  });

  it("redacts Authorization Bearer headers", () => {
    const text = "Authorization: Bearer abc123token456";
    expect(redactSecrets(text)).not.toContain("abc123token456");
  });

  it("redacts token= assignments", () => {
    const text = 'token="supersecretvalue"';
    expect(redactSecrets(text)).not.toContain("supersecretvalue");
  });

  it("redacts embedded URL credentials while preserving the host", () => {
    const text = "https://user:secretpass@github.com/owner/repo";
    const redacted = redactSecrets(text);
    expect(redacted).toContain("github.com");
    expect(redacted).not.toContain("secretpass");
  });

  it("leaves non-secret text unchanged", () => {
    expect(redactSecrets("just a normal log line")).toBe("just a normal log line");
  });
});

describe("resolveInjectionStrategy", () => {
  it("maps local to local-askpass", () => {
    expect(resolveInjectionStrategy("local")).toBe("local-askpass");
  });

  it("maps ssh-remote to remote-askpass", () => {
    expect(resolveInjectionStrategy("ssh-remote")).toBe("remote-askpass");
  });

  it("maps cloud to remote-ephemeral", () => {
    expect(resolveInjectionStrategy("cloud")).toBe("remote-ephemeral");
  });
});

describe("prepareCredentialInjection", () => {
  it.effect("creates an executable askpass helper for local and cleans it up", () =>
    Effect.gen(function* () {
      const prepared = yield* prepareCredentialInjection({
        category: "local",
        credential: "ghp_testtoken123",
        host: "github.com",
      });
      expect(prepared.strategy).toBe("local-askpass");
      expect(prepared.askpassScriptPath).not.toBeNull();
      const script = NodeFs.readFileSync(prepared.askpassScriptPath!, "utf8");
      // The credential is embedded in the temp script, but the script lives in
      // the OS temp dir under a random name, never in .git/config or the repo.
      expect(script).toContain("ghp_testtoken123");
      expect(prepared.env.GIT_ASKPASS).toBe(prepared.askpassScriptPath);
      expect(prepared.env.GIT_TERMINAL_PROMPT).toBe("0");
      yield* cleanup(prepared);
      // After cleanup the script is gone.
      expect(NodeFs.existsSync(prepared.askpassScriptPath!)).toBe(false);
    }).pipe(Effect.provide(FsLayer)));

  it.effect("forwards an ephemeral credential for cloud without an askpass script", () =>
    Effect.gen(function* () {
      const prepared = yield* prepareCredentialInjection({
        category: "cloud",
        credential: "ghp_cloudtoken",
        host: "github.com",
      });
      expect(prepared.strategy).toBe("remote-ephemeral");
      expect(prepared.askpassScriptPath).toBeNull();
      expect(prepared.ephemeralCredential).toBe("ghp_cloudtoken");
    }).pipe(Effect.provide(FsLayer)));

  it.effect("forwards an ephemeral credential for ssh-remote", () =>
    Effect.gen(function* () {
      const prepared = yield* prepareCredentialInjection({
        category: "ssh-remote",
        credential: "ghp_sshtoken",
        host: "github.com",
      });
      expect(prepared.strategy).toBe("remote-askpass");
      expect(prepared.ephemeralCredential).toBe("ghp_sshtoken");
      expect(prepared.env.GIT_TERMINAL_PROMPT).toBe("0");
    }).pipe(Effect.provide(FsLayer)));
});
