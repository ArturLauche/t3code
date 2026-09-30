/**
 * Secret handling for user-supplied OpenCode provider API keys.
 *
 * The provider map lives inside `providerInstances[id].config`, which is an
 * opaque blob: every helper here narrows that blob instead of assuming the
 * driver decoded it. The stored shape follows the existing provider
 * environment convention — an `apiKeyRedacted: true` marker in settings.json
 * with the real value in the secret store — so a client that reads settings,
 * writes them back unchanged, never sees or clobbers a key.
 */
export interface OpenCodeProviderApiKeyRef {
  readonly providerId: string;
  readonly apiKey: string;
  readonly apiKeyRedacted: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readProviderEntries(config: unknown): Record<string, Record<string, unknown>> {
  if (!isPlainObject(config) || !isPlainObject(config.providers)) return {};
  const entries: Record<string, Record<string, unknown>> = {};
  for (const [providerId, entry] of Object.entries(config.providers)) {
    if (isPlainObject(entry)) entries[providerId] = entry;
  }
  return entries;
}

type OpenCodeProviderConfigBlob = Record<string, unknown> & {
  readonly providers: Record<string, unknown>;
};

/**
 * The blob is shared with every other driver; only an instance whose config
 * carries a provider map is ours to touch.
 */
/**
 * Whether a secret is stored for this provider. The in-memory settings keep
 * the redaction marker with an empty key, so the marker — not the value — is
 * what says "there is something to delete".
 */
function hasStoredKey(entry: Record<string, unknown> | undefined): boolean {
  if (!entry) return false;
  return (
    entry.apiKeyRedacted === true || (typeof entry.apiKey === "string" && entry.apiKey.length > 0)
  );
}

function isOpenCodeProviderConfig(config: unknown): config is OpenCodeProviderConfigBlob {
  return isPlainObject(config) && isPlainObject(config.providers);
}

export function openCodeProviderApiKeySecretName(input: {
  readonly instanceId: string;
  readonly providerId: string;
}): string {
  const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  return `opencode-provider-${encode(input.instanceId)}-${encode(input.providerId)}-api-key`;
}

/** Every provider entry in the blob that holds (or defers to) an API key. */
export function listOpenCodeProviderApiKeys(
  config: unknown,
): ReadonlyArray<OpenCodeProviderApiKeyRef> {
  return Object.entries(readProviderEntries(config)).flatMap(([providerId, entry]) => {
    const apiKey = typeof entry.apiKey === "string" ? entry.apiKey : "";
    const apiKeyRedacted = entry.apiKeyRedacted === true;
    if (apiKey.length === 0 && !apiKeyRedacted) return [];
    return [{ providerId, apiKey, apiKeyRedacted }];
  });
}

/**
 * Replace keys with the redacted marker. Applied to the copy sent to clients;
 * the on-disk file already carries the marker, so this only matters for the
 * in-memory settings the server itself holds.
 */
export function redactOpenCodeProviderApiKeys(config: unknown): unknown {
  if (!isOpenCodeProviderConfig(config)) return config;
  const entries = readProviderEntries(config);
  const providers: Record<string, unknown> = {};
  let changed = false;
  for (const [providerId, entry] of Object.entries(entries)) {
    const apiKey = typeof entry.apiKey === "string" ? entry.apiKey : "";
    if (apiKey.length === 0) {
      providers[providerId] = entry;
      continue;
    }
    providers[providerId] = { ...entry, apiKey: "", apiKeyRedacted: true };
    changed = true;
  }
  if (!changed) return config;
  return { ...config, providers };
}

/**
 * Fill redacted entries back in from `resolve`. A key with no stored secret
 * resolves to an empty string, which is what OpenCode treats as "no key".
 */
export function materializeOpenCodeProviderApiKeys(
  config: unknown,
  resolve: (providerId: string) => string,
): unknown {
  if (!isOpenCodeProviderConfig(config)) return config;
  const entries = readProviderEntries(config);
  const providers: Record<string, unknown> = {};
  let changed = false;
  for (const [providerId, entry] of Object.entries(entries)) {
    if (entry.apiKeyRedacted !== true) {
      providers[providerId] = entry;
      continue;
    }
    providers[providerId] = { ...entry, apiKey: resolve(providerId) };
    changed = true;
  }
  if (!changed) return config;
  return { ...config, providers };
}

export interface OpenCodeProviderApiKeyWrite {
  readonly providerId: string;
  readonly value: string;
}

export interface PersistedOpenCodeProviderApiKeys {
  /** The next config blob, with every key replaced by the redaction marker. */
  readonly config: unknown;
  readonly writes: ReadonlyArray<OpenCodeProviderApiKeyWrite>;
  /**
   * Providers whose stored secret must survive this update, whether it was
   * just written or merely echoed back as the marker. Anything not listed here
   * and not in `removedProviderIds` has no stored secret.
   */
  readonly retainedProviderIds: ReadonlyArray<string>;
  /** Providers whose key was removed and whose stored secret must be deleted. */
  readonly removedProviderIds: ReadonlyArray<string>;
}

/**
 * Decide what the secret store must do for one instance's provider map.
 *
 * A client that echoes the marker back means "keep the stored key", so the
 * previous blob is consulted for a plaintext value to migrate (a key typed
 * straight into settings.json) exactly as provider environment secrets do.
 */
export function planOpenCodeProviderApiKeyPersistence(input: {
  readonly nextConfig: unknown;
  readonly currentConfig: unknown;
}): PersistedOpenCodeProviderApiKeys {
  const nextEntries = readProviderEntries(input.nextConfig);
  const currentEntries = readProviderEntries(input.currentConfig);
  const providers: Record<string, unknown> = {};
  const writes: OpenCodeProviderApiKeyWrite[] = [];
  const retainedProviderIds: string[] = [];
  const removedProviderIds: string[] = [];
  let changed = false;

  for (const [providerId, nextEntry] of Object.entries(nextEntries)) {
    const apiKey = typeof nextEntry.apiKey === "string" ? nextEntry.apiKey : "";
    const apiKeyRedacted = nextEntry.apiKeyRedacted === true;
    if (apiKeyRedacted) {
      const currentApiKey =
        typeof currentEntries[providerId]?.apiKey === "string"
          ? (currentEntries[providerId].apiKey as string)
          : "";
      if (currentApiKey.length > 0) {
        writes.push({ providerId, value: currentApiKey });
      }
      // The stored key is still there, so a sweep for orphaned secrets must
      // not take it away.
      retainedProviderIds.push(providerId);
      providers[providerId] = nextEntry;
      continue;
    }
    if (apiKey.length > 0) {
      writes.push({ providerId, value: apiKey });
      retainedProviderIds.push(providerId);
      providers[providerId] = { ...nextEntry, apiKey: "", apiKeyRedacted: true };
      changed = true;
      continue;
    }
    // No key left to store.
    if (hasStoredKey(currentEntries[providerId])) removedProviderIds.push(providerId);
    const { apiKey: _omit, apiKeyRedacted: _redacted, ...rest } = nextEntry;
    providers[providerId] = rest;
    changed = true;
  }

  for (const [providerId, currentEntry] of Object.entries(currentEntries)) {
    if (providerId in providers) continue;
    if (hasStoredKey(currentEntry)) removedProviderIds.push(providerId);
  }

  const config =
    changed && isOpenCodeProviderConfig(input.nextConfig)
      ? { ...input.nextConfig, providers }
      : input.nextConfig;
  return { config, writes, retainedProviderIds, removedProviderIds };
}
