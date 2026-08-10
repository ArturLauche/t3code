import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopIntegrationStore from "./DesktopIntegrationStore.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const safeStorageLayer = Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
  isEncryptionAvailable: Effect.succeed(true),
  encryptString: (value) => Effect.succeed(encoder.encode(`os-encrypted:${value}`)),
  decryptString: (value) => Effect.succeed(decoder.decode(value).slice("os-encrypted:".length)),
  selectedStorageBackend: Effect.succeed(Option.none()),
} satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);

function integrationLayer(baseDir: string) {
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/repo/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );
  return DesktopIntegrationStore.layer.pipe(
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(safeStorageLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

const withStore = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopIntegrationStore.DesktopIntegrationStore>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-integrations-test-",
    });
    return yield* effect.pipe(Effect.provide(integrationLayer(baseDir)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopIntegrationStore", () => {
  it.effect(
    "encrypts provider and GitHub credentials and supports multiple provider accounts",
    () =>
      withStore(
        Effect.gen(function* () {
          const store = yield* DesktopIntegrationStore.DesktopIntegrationStore;
          const environment = yield* DesktopEnvironment.DesktopEnvironment;
          const fileSystem = yield* FileSystem.FileSystem;
          const first = yield* store.saveProviderConnection({
            provider: "daytona",
            label: "Daytona work",
            apiKey: "daytona-secret-one",
          });
          const second = yield* store.saveProviderConnection({
            provider: "daytona",
            label: "Daytona personal",
            apiKey: "daytona-secret-two",
          });
          yield* store.setGitHubCredential({
            mode: "personal-access-token",
            token: "github-pat-secret",
            account: {
              login: "octocat",
              name: null,
              avatarUrl: null,
              profileUrl: "https://github.com/octocat",
            },
            expiresAt: null,
          });

          assert.notEqual(first.id, second.id);
          assert.lengthOf(yield* store.listProviderConnections, 2);
          const raw = yield* fileSystem.readFileString(
            `${environment.stateDir}/integration-secrets.json`,
          );
          assert.notInclude(raw, "daytona-secret-one");
          assert.notInclude(raw, "daytona-secret-two");
          assert.notInclude(raw, "github-pat-secret");
          assert.include(raw, "encrypted");
        }),
      ),
  );

  it.effect("persists and clears the sandbox-to-project association", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopIntegrationStore.DesktopIntegrationStore;
        const connection = yield* store.saveProviderConnection({
          provider: "e2b",
          label: "E2B",
          apiKey: "e2b-secret",
        });

        yield* store.setAssociation({
          providerConnectionId: connection.id,
          sandboxId: "sandbox-1",
          project: "/home/user/project",
        });
        assert.deepStrictEqual(
          yield* store.getAssociation(connection.id, "sandbox-1"),
          Option.some("/home/user/project"),
        );
        yield* store.setAssociation({
          providerConnectionId: connection.id,
          sandboxId: "sandbox-1",
          project: null,
        });
        assert.isTrue(Option.isNone(yield* store.getAssociation(connection.id, "sandbox-1")));
      }),
    ),
  );
});
