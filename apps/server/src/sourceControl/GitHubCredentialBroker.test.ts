import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentAuthenticatedPrincipal } from "@t3tools/contracts";
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

const principal = (sessionId: string) =>
  ({
    sessionId,
    subject: `test:${sessionId}`,
    method: "bearer",
    scopes: [],
  }) as never;

it.effect("scopes ephemeral GitHub credentials to the authenticated session", () =>
  Effect.gen(function* () {
    const broker = yield* GitHubCredentialBroker.GitHubCredentialBroker;
    yield* broker.injectEphemeral({ sessionId: "session-a", token: "github_pat_session_a" });
    yield* broker.injectEphemeral({ sessionId: "session-b", token: "github_pat_session_b" });

    assert.deepStrictEqual(
      yield* broker.getToken.pipe(
        Effect.provideService(EnvironmentAuthenticatedPrincipal, principal("session-a")),
      ),
      Option.some("github_pat_session_a"),
    );
    assert.deepStrictEqual(
      yield* broker.getToken.pipe(
        Effect.provideService(EnvironmentAuthenticatedPrincipal, principal("session-b")),
      ),
      Option.some("github_pat_session_b"),
    );
    assert.isTrue(Option.isNone(yield* broker.getToken));
  }).pipe(Effect.provide(brokerLayer)),
);

it.effect("uses a host-restricted askpass helper without exposing the token in generic env", () =>
  Effect.gen(function* () {
    const broker = yield* GitHubCredentialBroker.GitHubCredentialBroker;
    const fileSystem = yield* FileSystem.FileSystem;
    const token = "github_pat_test_super_secret";

    yield* broker.injectEphemeral({ sessionId: "session-a", token, ttlSeconds: 60 });
    const environment = Option.getOrThrow(
      yield* broker.processEnvironment.pipe(
        Effect.provideService(EnvironmentAuthenticatedPrincipal, principal("session-a")),
      ),
    );

    assert.isUndefined(environment.GH_TOKEN);
    assert.isUndefined(environment.GITHUB_TOKEN);
    assert.isUndefined(environment.T3_GITHUB_TOKEN);
    assert.strictEqual(environment.GIT_TERMINAL_PROMPT, "0");
    assert.strictEqual(environment.GIT_CONFIG_KEY_0, "core.hooksPath");
    const wrapper = yield* fileSystem.readFileString(environment.GIT_ASKPASS!);
    const helper = yield* fileSystem.readFileString(environment.T3_GITHUB_ASKPASS_SCRIPT!);
    assert.notInclude(wrapper, "node ");
    assert.include(wrapper, "T3_GITHUB_NODE_EXECUTABLE");
    assert.notInclude(helper, token);
    assert.include(helper, 'remote.hostname.toLowerCase() !== "github.com"');
    assert.include(helper, 'remote.protocol !== "https:"');
  }).pipe(Effect.provide(brokerLayer)),
);

it.effect("retains the existing secure-store fallback for self-hosted GitHub credentials", () =>
  Effect.gen(function* () {
    const broker = yield* GitHubCredentialBroker.GitHubCredentialBroker;

    yield* broker.setPersistentToken("github_pat_persisted");
    assert.deepStrictEqual(yield* broker.getToken, Option.some("github_pat_persisted"));
    yield* broker.injectEphemeral({
      sessionId: "session-a",
      token: "github_pat_ephemeral",
      ttlSeconds: 60,
    });
    assert.deepStrictEqual(
      yield* broker.getToken.pipe(
        Effect.provideService(EnvironmentAuthenticatedPrincipal, principal("session-a")),
      ),
      Option.some("github_pat_ephemeral"),
    );
    yield* broker.clearEphemeral("session-a");
    assert.deepStrictEqual(yield* broker.getToken, Option.some("github_pat_persisted"));
    yield* broker.clearPersistentToken;
  }).pipe(Effect.provide(brokerLayer)),
);
