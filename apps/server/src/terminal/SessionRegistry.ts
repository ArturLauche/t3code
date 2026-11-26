import {
  TerminalSessionCreateInput,
  TerminalSessionDeleteInput,
  TerminalSessionRecord,
  TerminalSessionRenameInput,
  TerminalSessionStoreError,
  TerminalSessionId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as ServerConfig from "../config.ts";

const RecordsJson = Schema.fromJsonString(Schema.Array(TerminalSessionRecord));
const decodeRecords = Schema.decodeUnknownOption(RecordsJson);
const encodeRecords = Schema.encodeEffect(RecordsJson);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Persisted "sticky" terminal sessions. Each record's `id` doubles as the
 * `threadId` for `terminal.*` calls, so its PTY and scrollback history —
 * already on disk under the terminal logs dir — survive restarts with it.
 */
export class TerminalSessionRegistry extends Context.Service<
  TerminalSessionRegistry,
  {
    readonly list: () => Effect.Effect<
      ReadonlyArray<TerminalSessionRecord>,
      TerminalSessionStoreError
    >;
    readonly create: (
      input: TerminalSessionCreateInput,
    ) => Effect.Effect<TerminalSessionRecord, TerminalSessionStoreError>;
    readonly rename: (
      input: TerminalSessionRenameInput,
    ) => Effect.Effect<TerminalSessionRecord, TerminalSessionStoreError>;
    readonly remove: (
      input: TerminalSessionDeleteInput,
    ) => Effect.Effect<void, TerminalSessionStoreError>;
  }
>()("t3/terminal/SessionRegistry/TerminalSessionRegistry") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const random = yield* SecureRandom.SecureRandom;
  const config = yield* ServerConfig.ServerConfig;
  const storePath = path.join(config.stateDir, "terminal-sessions.json");

  const recordsRef = yield* Ref.make<ReadonlyArray<TerminalSessionRecord>>([]);
  yield* fs.readFileString(storePath).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
    }),
    Effect.flatMap((raw) => {
      if (raw === null || raw.trim().length === 0) return Effect.void;
      const decoded = decodeRecords(raw);
      if (decoded._tag === "None") {
        return Effect.logWarning("terminal session store failed to decode; starting empty", {
          path: storePath,
        });
      }
      return Ref.set(recordsRef, decoded.value);
    }),
    Effect.catch((error) =>
      Effect.logWarning("failed to load terminal session store", {
        path: storePath,
        error,
      }),
    ),
  );

  const persist = (records: ReadonlyArray<TerminalSessionRecord>) =>
    encodeRecords(records).pipe(
      Effect.flatMap((encoded) =>
        writeFileStringAtomically({ filePath: storePath, contents: encoded }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.provideService(HostProcess.Platform, platform),
        ),
      ),
      Effect.mapError((cause) => new TerminalSessionStoreError({ operation: "write", cause })),
    );

  /** Applies `f` to the stored records and persists the result; `f` may decline by returning undefined. */
  const update = Effect.fn("TerminalSessionRegistry.update")(function* <A>(
    f: (
      records: ReadonlyArray<TerminalSessionRecord>,
    ) => { readonly records: ReadonlyArray<TerminalSessionRecord>; readonly result: A } | undefined,
  ): Effect.fn.Return<A | undefined, TerminalSessionStoreError> {
    const records = yield* Ref.get(recordsRef);
    const outcome = f(records);
    if (outcome === undefined) return undefined;
    yield* Ref.set(recordsRef, outcome.records);
    yield* persist(outcome.records);
    return outcome.result;
  });

  const list = () => Ref.get(recordsRef).pipe(Effect.map((records) => [...records]));

  const create = Effect.fn("TerminalSessionRegistry.create")(function* (
    input: TerminalSessionCreateInput,
  ) {
    const now = yield* nowIso;
    const record: TerminalSessionRecord = {
      id: TerminalSessionId.make(yield* random.uuidV4()),
      projectId: input.projectId,
      title: input.title ?? (path.basename(input.cwd) || "Terminal"),
      cwd: input.cwd,
      worktreePath: input.worktreePath ?? null,
      ...(input.providerInstanceId !== undefined
        ? { providerInstanceId: input.providerInstanceId }
        : {}),
      createdAt: now,
      updatedAt: now,
    };
    const created = yield* update((records) => ({
      records: [...records, record],
      result: record,
    }));
    return created as TerminalSessionRecord;
  });

  const rename = Effect.fn("TerminalSessionRegistry.rename")(function* (
    input: TerminalSessionRenameInput,
  ) {
    const now = yield* nowIso;
    const renamed = yield* update((records) => {
      const index = records.findIndex((record) => record.id === input.id);
      const existing = records[index];
      if (existing === undefined) return undefined;
      const next: TerminalSessionRecord = { ...existing, title: input.title, updatedAt: now };
      const nextRecords = [...records];
      nextRecords[index] = next;
      return { records: nextRecords, result: next };
    });
    if (renamed === undefined) {
      return yield* new TerminalSessionStoreError({
        operation: "read",
        cause: `Unknown terminal session: ${input.id}`,
      });
    }
    return renamed;
  });

  const remove = Effect.fn("TerminalSessionRegistry.remove")(function* (
    input: TerminalSessionDeleteInput,
  ) {
    yield* update((records) => {
      const next = records.filter((record) => record.id !== input.id);
      if (next.length === records.length) return undefined;
      return { records: next, result: undefined };
    });
  });

  return TerminalSessionRegistry.of({ list, create, rename, remove });
});

export const layer = Layer.effect(TerminalSessionRegistry, make);
