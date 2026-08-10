import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitHubCredentialBroker from "./GitHubCredentialBroker.ts";

const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-github-broker-test-" });
const brokerLayer = GitHubCredentialBroker.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(configLayer),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(Layer.succeed(HostProcessPlatform, "linux")),
);

it.effect(
  "injects GitHub credentials only through a process environment and secret-free helper",
  () =>
    Effect.gen(function* () {
      const broker = yield* GitHubCredentialBroker.GitHubCredentialBroker;
      const fileSystem = yield* FileSystem.FileSystem;
      const token = "github_pat_test-super-secret";

      yield* broker.injectEphemeral({ token, ttlSeconds: 60 });
      const environment = Option.getOrThrow(yield* broker.processEnvironment);

      assert.strictEqual(environment.GH_TOKEN, token);
      assert.strictEqual(environment.GITHUB_TOKEN, token);
      assert.strictEqual(environment.T3_GITHUB_TOKEN, token);
      assert.strictEqual(environment.GIT_TERMINAL_PROMPT, "0");
      const helper = yield* fileSystem.readFileString(environment.GIT_ASKPASS!);
      assert.notInclude(helper, token);
      assert.include(helper, "T3_GITHUB_TOKEN");

      yield* broker.clearEphemeral;
      assert.isTrue(Option.isNone(yield* broker.getToken));
    }).pipe(Effect.provide(brokerLayer)),
);

it.effect("retains the existing secure-store fallback for self-hosted GitHub credentials", () =>
  Effect.gen(function* () {
    const broker = yield* GitHubCredentialBroker.GitHubCredentialBroker;

    yield* broker.setPersistentToken("github_pat_persisted");
    assert.deepStrictEqual(yield* broker.getToken, Option.some("github_pat_persisted"));
    yield* broker.injectEphemeral({ token: "github_pat_ephemeral", ttlSeconds: 60 });
    assert.deepStrictEqual(yield* broker.getToken, Option.some("github_pat_ephemeral"));
    yield* broker.clearEphemeral;
    assert.deepStrictEqual(yield* broker.getToken, Option.some("github_pat_persisted"));
    yield* broker.clearPersistentToken;
  }).pipe(Effect.provide(brokerLayer)),
);
