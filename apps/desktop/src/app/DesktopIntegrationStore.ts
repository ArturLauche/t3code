import {
  CloudSandboxProviderConnection,
  CloudSandboxProviderConnectionId,
  GitHubAccount,
  GitHubConnectionMode,
  type CloudSandboxAssociationInput,
  type CloudSandboxProviderConnection as CloudSandboxProviderConnectionType,
  type CloudSandboxProviderConnectionInput,
  type GitHubAccount as GitHubAccountType,
  type GitHubConnectionMode as GitHubConnectionModeType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const ProviderSecret = Schema.Struct({
  connection: CloudSandboxProviderConnection,
  apiKey: Schema.String,
});

const GitHubSecret = Schema.Struct({
  mode: GitHubConnectionMode,
  token: Schema.String,
  account: GitHubAccount,
  expiresAt: Schema.NullOr(Schema.String),
});

const SandboxAssociation = Schema.Struct({
  providerConnectionId: CloudSandboxProviderConnectionId,
  sandboxId: Schema.String,
  project: Schema.String,
});

const SecretDocument = Schema.Struct({
  version: Schema.Literal(1),
  providers: Schema.Array(ProviderSecret),
  github: Schema.NullOr(GitHubSecret),
  associations: Schema.Array(SandboxAssociation),
});
type SecretDocument = typeof SecretDocument.Type;

const EncryptedDocument = Schema.Struct({
  version: Schema.Literal(1),
  encrypted: Schema.String,
});

const decodeEncryptedDocument = Schema.decodeUnknownEffect(
  Schema.fromJsonString(EncryptedDocument),
);
const encodeEncryptedDocument = Schema.encodeEffect(Schema.fromJsonString(EncryptedDocument));
const decodeSecretDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(SecretDocument));
const encodeSecretDocument = Schema.encodeEffect(Schema.fromJsonString(SecretDocument));

const emptyDocument = (): SecretDocument => ({
  version: 1,
  providers: [],
  github: null,
  associations: [],
});

export interface StoredProviderConnection {
  readonly connection: CloudSandboxProviderConnectionType;
  readonly apiKey: string;
}

export interface StoredGitHubCredential {
  readonly mode: GitHubConnectionModeType;
  readonly token: string;
  readonly account: GitHubAccountType;
  readonly expiresAt: string | null;
}

export class DesktopIntegrationStoreError extends Schema.TaggedErrorClass<DesktopIntegrationStoreError>()(
  "DesktopIntegrationStoreError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Secure integration storage failed during ${this.operation}.`;
  }
}

export class DesktopIntegrationStore extends Context.Service<
  DesktopIntegrationStore,
  {
    readonly listProviderConnections: Effect.Effect<
      readonly CloudSandboxProviderConnectionType[],
      DesktopIntegrationStoreError
    >;
    readonly getProviderConnection: (
      id: string,
    ) => Effect.Effect<Option.Option<StoredProviderConnection>, DesktopIntegrationStoreError>;
    readonly saveProviderConnection: (
      input: CloudSandboxProviderConnectionInput,
    ) => Effect.Effect<CloudSandboxProviderConnectionType, DesktopIntegrationStoreError>;
    readonly markProviderValidated: (
      id: string,
    ) => Effect.Effect<CloudSandboxProviderConnectionType, DesktopIntegrationStoreError>;
    readonly removeProviderConnection: (
      id: string,
    ) => Effect.Effect<void, DesktopIntegrationStoreError>;
    readonly getGitHubCredential: Effect.Effect<
      Option.Option<StoredGitHubCredential>,
      DesktopIntegrationStoreError
    >;
    readonly setGitHubCredential: (
      credential: StoredGitHubCredential,
    ) => Effect.Effect<void, DesktopIntegrationStoreError>;
    readonly clearGitHubCredential: Effect.Effect<void, DesktopIntegrationStoreError>;
    readonly getAssociation: (
      providerConnectionId: string,
      sandboxId: string,
    ) => Effect.Effect<Option.Option<string>, DesktopIntegrationStoreError>;
    readonly setAssociation: (
      input: CloudSandboxAssociationInput,
    ) => Effect.Effect<void, DesktopIntegrationStoreError>;
  }
>()("@t3tools/desktop/app/DesktopIntegrationStore") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const crypto = yield* Crypto.Crypto;
  const mutex = yield* Semaphore.make(1);
  const storePath = path.join(environment.stateDir, "integration-secrets.json");

  const fail = (operation: string, cause: unknown) =>
    new DesktopIntegrationStoreError({ operation, cause });

  const readUnlocked = Effect.fn("desktop.integrationStore.read")(function* () {
    const available = yield* safeStorage.isEncryptionAvailable.pipe(
      Effect.mapError((cause) => fail("check-encryption", cause)),
    );
    if (!available) {
      return yield* fail("check-encryption", new Error("OS secure storage is unavailable."));
    }
    const raw = yield* fileSystem
      .readFileString(storePath)
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed<string | null>(null)
            : Effect.fail(fail("read", error)),
        ),
      );
    if (raw === null) return emptyDocument();
    const outer = yield* decodeEncryptedDocument(raw).pipe(
      Effect.mapError((cause) => fail("decode-container", cause)),
    );
    const encrypted = yield* Effect.fromResult(Encoding.decodeBase64(outer.encrypted)).pipe(
      Effect.mapError((cause) => fail("decode-ciphertext", cause)),
    );
    const decrypted = yield* safeStorage
      .decryptString(encrypted)
      .pipe(Effect.mapError((cause) => fail("decrypt", cause)));
    return yield* decodeSecretDocument(decrypted).pipe(
      Effect.mapError((cause) => fail("decode-secrets", cause)),
    );
  });

  const writeUnlocked = Effect.fn("desktop.integrationStore.write")(function* (
    document: SecretDocument,
  ) {
    const available = yield* safeStorage.isEncryptionAvailable.pipe(
      Effect.mapError((cause) => fail("check-encryption", cause)),
    );
    if (!available) {
      return yield* fail("check-encryption", new Error("OS secure storage is unavailable."));
    }
    const plaintext = yield* encodeSecretDocument(document).pipe(
      Effect.mapError((cause) => fail("encode-secrets", cause)),
    );
    const encrypted = yield* safeStorage
      .encryptString(plaintext)
      .pipe(Effect.mapError((cause) => fail("encrypt", cause)));
    const encoded = yield* encodeEncryptedDocument({
      version: 1,
      encrypted: Encoding.encodeBase64(encrypted),
    }).pipe(Effect.mapError((cause) => fail("encode-container", cause)));
    const directory = path.dirname(storePath);
    const suffix = (yield* crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) => fail("create-temporary-file-name", cause)),
    )).replaceAll("-", "");
    const temporaryPath = `${storePath}.${process.pid}.${suffix}.tmp`;
    yield* fileSystem
      .makeDirectory(directory, { recursive: true })
      .pipe(Effect.mapError((cause) => fail("create-directory", cause)));
    yield* fileSystem
      .chmod(directory, 0o700)
      .pipe(Effect.mapError((cause) => fail("protect-directory", cause)));
    yield* fileSystem
      .writeFileString(temporaryPath, `${encoded}\n`)
      .pipe(Effect.mapError((cause) => fail("write", cause)));
    yield* fileSystem
      .chmod(temporaryPath, 0o600)
      .pipe(Effect.mapError((cause) => fail("protect-temporary-file", cause)));
    yield* fileSystem.rename(temporaryPath, storePath).pipe(
      Effect.mapError((cause) => fail("replace", cause)),
      Effect.ensuring(fileSystem.remove(temporaryPath, { force: true }).pipe(Effect.ignore)),
    );
  });

  const read = mutex.withPermits(1)(readUnlocked());
  const update = <A>(
    operation: string,
    transform: (
      document: SecretDocument,
    ) => Effect.Effect<readonly [A, SecretDocument], DesktopIntegrationStoreError>,
  ): Effect.Effect<A, DesktopIntegrationStoreError> =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* readUnlocked();
        const [result, next] = yield* transform(current);
        yield* writeUnlocked(next);
        return result;
      }).pipe(Effect.withSpan(`desktop.integrationStore.${operation}`)),
    );

  return DesktopIntegrationStore.of({
    listProviderConnections: read.pipe(
      Effect.map((document) => document.providers.map(({ connection }) => connection)),
    ),
    getProviderConnection: (id) =>
      read.pipe(
        Effect.map((document) =>
          Option.fromUndefinedOr(document.providers.find(({ connection }) => connection.id === id)),
        ),
      ),
    saveProviderConnection: (input) =>
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        const generatedId = `${input.provider}:${yield* crypto.randomUUIDv4.pipe(
          Effect.mapError((cause) => fail("create-provider-id", cause)),
        )}`;
        return yield* update("saveProvider", (document) => {
          const connection: CloudSandboxProviderConnectionType = {
            id: generatedId as CloudSandboxProviderConnectionType["id"],
            provider: input.provider,
            label: input.label,
            apiUrl: input.apiUrl ?? null,
            credentialConfigured: true,
            createdAt: now,
            lastValidatedAt: null,
          };
          return Effect.succeed([
            connection,
            {
              ...document,
              providers: [
                ...document.providers.filter(
                  ({ connection: candidate }) => candidate.id !== connection.id,
                ),
                { connection, apiKey: input.apiKey },
              ],
            },
          ] as const);
        });
      }),
    markProviderValidated: (id) =>
      Effect.gen(function* () {
        const validatedAt = DateTime.formatIso(yield* DateTime.now);
        return yield* update("markProviderValidated", (document) => {
          const stored = document.providers.find(({ connection }) => connection.id === id);
          if (!stored) {
            return Effect.fail(
              fail(
                "mark-provider-validated",
                new Error(`Sandbox provider connection ${id} does not exist.`),
              ),
            );
          }
          const connection = { ...stored.connection, lastValidatedAt: validatedAt };
          return Effect.succeed([
            connection,
            {
              ...document,
              providers: document.providers.map((candidate) =>
                candidate.connection.id === id ? { ...candidate, connection } : candidate,
              ),
            },
          ] as const);
        });
      }),
    removeProviderConnection: (id) =>
      update("removeProvider", (document) =>
        Effect.succeed([
          undefined,
          {
            ...document,
            providers: document.providers.filter(({ connection }) => connection.id !== id),
            associations: document.associations.filter(
              (association) => association.providerConnectionId !== id,
            ),
          },
        ] as const),
      ),
    getGitHubCredential: read.pipe(Effect.map((document) => Option.fromNullishOr(document.github))),
    setGitHubCredential: (credential) =>
      update("setGitHub", (document) =>
        Effect.succeed([undefined, { ...document, github: credential }] as const),
      ),
    clearGitHubCredential: update("clearGitHub", (document) =>
      Effect.succeed([undefined, { ...document, github: null }] as const),
    ),
    getAssociation: (providerConnectionId, sandboxId) =>
      read.pipe(
        Effect.map((document) =>
          Option.fromUndefinedOr(
            document.associations.find(
              (association) =>
                association.providerConnectionId === providerConnectionId &&
                association.sandboxId === sandboxId,
            )?.project,
          ),
        ),
      ),
    setAssociation: (input) =>
      update("setAssociation", (document) => {
        const associations = document.associations.filter(
          (association) =>
            association.providerConnectionId !== input.providerConnectionId ||
            association.sandboxId !== input.sandboxId,
        );
        if (input.project !== null) associations.push({ ...input, project: input.project });
        return Effect.succeed([undefined, { ...document, associations }] as const);
      }),
  });
});

export const layer = Layer.effect(DesktopIntegrationStore, make);
