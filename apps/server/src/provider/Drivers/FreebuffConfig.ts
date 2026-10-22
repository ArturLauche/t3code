import type { FreebuffSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

export const resolveFreebuffConfigDir = Effect.fn("resolveFreebuffConfigDir")(function* (input: {
  readonly settings: FreebuffSettings;
  readonly instanceId: ProviderInstanceId;
  readonly stateDir: string;
}): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const configured = input.settings.configDir.trim();
  if (configured) {
    const expanded = expandHomePath(configured, home);
    return path.isAbsolute(expanded) ? expanded : path.resolve(input.stateDir, expanded);
  }
  return path.join(input.stateDir, "freebuff", input.instanceId);
});

export const ensureFreebuffConfigDir = Effect.fn("ensureFreebuffConfigDir")(function* (
  configDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.makeDirectory(configDir, { recursive: true });
  yield* fileSystem.chmod(configDir, 0o700).pipe(Effect.ignore);
  return configDir;
});
