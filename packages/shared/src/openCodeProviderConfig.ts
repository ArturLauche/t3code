/**
 * Translation between T3 Code's OpenCode provider settings and OpenCode's own
 * configuration document.
 *
 * T3 Code persists a small, narrowed projection of OpenCode's
 * `provider.<id>` map. This module is the only place that knows how that
 * projection maps onto OpenCode's field names, so the driver, the settings
 * service, and the Settings UI all agree without re-deriving the mapping.
 *
 * OpenCode stays the resolver: T3 Code hands it a config and reads back
 * whatever providers and models it decided to connect. Nothing here predicts
 * or caches that outcome.
 */
import {
  OPEN_CODE_MAX_ENV_VARS_PER_PROVIDER,
  OPEN_CODE_MAX_MODEL_ID_LENGTH,
  OPEN_CODE_MAX_MODEL_VARIANTS,
  OPEN_CODE_MAX_MODELS_PER_PROVIDER,
  OPEN_CODE_MAX_NPM_LENGTH,
  OPEN_CODE_MAX_PROVIDER_ID_LENGTH,
  OPEN_CODE_MAX_PROVIDERS,
  OPEN_CODE_PROVIDER_ID_PATTERN,
  type OpenCodeProviderModelSetting,
  type OpenCodeProviderSettings,
  type OpenCodeProviderSettingsMap,
} from "@t3tools/contracts";

const OPENCODE_EMPTY_CONFIG_CONTENT = "{}";

const trimmedOrUndefined = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/** Deduplicate while preserving order, dropping blanks. */
function trimmedList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const trimmed = trimmedOrUndefined(raw);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    entries.push(trimmed);
  }
  return entries.length > 0 ? entries : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readOpenCodeModelSetting(value: unknown): OpenCodeProviderModelSetting | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const modelId = trimmedOrUndefined(record.modelId);
  if (!modelId || modelId.length > OPEN_CODE_MAX_MODEL_ID_LENGTH) return undefined;
  if (modelId.startsWith("/") || modelId.endsWith("/")) return undefined;

  const entry: Record<string, unknown> = { modelId };
  const id = trimmedOrUndefined(record.id);
  if (id) entry.id = id;
  const name = trimmedOrUndefined(record.name);
  if (name) entry.name = name;
  const reasoning = optionalBoolean(record.reasoning);
  if (reasoning !== undefined) entry.reasoning = reasoning;
  const attachment = optionalBoolean(record.attachment);
  if (attachment !== undefined) entry.attachment = attachment;
  const temperature = optionalBoolean(record.temperature);
  if (temperature !== undefined) entry.temperature = temperature;
  const toolCall = optionalBoolean(record.toolCall);
  if (toolCall !== undefined) entry.toolCall = toolCall;
  const contextLimit = optionalInteger(record.contextLimit);
  if (contextLimit !== undefined) entry.contextLimit = contextLimit;
  const outputLimit = optionalInteger(record.outputLimit);
  if (outputLimit !== undefined) entry.outputLimit = outputLimit;
  const status = record.status;
  if (status === "alpha" || status === "beta" || status === "deprecated" || status === "active") {
    entry.status = status;
  }
  const variants = trimmedList(record.variants)?.slice(0, OPEN_CODE_MAX_MODEL_VARIANTS);
  if (variants) entry.variants = variants;
  return entry as OpenCodeProviderModelSetting;
}

/**
 * Read the OpenCode provider map out of the opaque per-instance config blob.
 * Malformed rows are dropped rather than failing the whole map: one bad entry
 * must not hide the good ones, and the Settings editor only offers back what
 * survived.
 */
export function readOpenCodeProviderSettings(value: unknown): OpenCodeProviderSettingsMap {
  if (!isPlainObject(value)) return {};
  const result: Record<string, OpenCodeProviderSettings> = {};
  for (const [rawId, rawEntry] of Object.entries(value)) {
    const providerId = trimmedOrUndefined(rawId);
    if (!providerId || !OPEN_CODE_PROVIDER_ID_PATTERN.test(providerId)) continue;
    if (providerId.length > OPEN_CODE_MAX_PROVIDER_ID_LENGTH) continue;
    if (!isPlainObject(rawEntry)) continue;
    const record = rawEntry;
    const models: OpenCodeProviderModelSetting[] = [];
    const seenModelIds = new Set<string>();
    if (Array.isArray(record.models)) {
      for (const rawModel of record.models) {
        const model = readOpenCodeModelSetting(rawModel);
        if (!model || seenModelIds.has(model.modelId)) continue;
        seenModelIds.add(model.modelId);
        models.push(model);
        if (models.length >= OPEN_CODE_MAX_MODELS_PER_PROVIDER) break;
      }
    }
    const entry: Record<string, unknown> = {};
    const name = trimmedOrUndefined(record.name);
    if (name) entry.name = name;
    const npm = trimmedOrUndefined(record.npm);
    if (npm && npm.length <= OPEN_CODE_MAX_NPM_LENGTH) entry.npm = npm;
    const env = trimmedList(record.env)?.slice(0, OPEN_CODE_MAX_ENV_VARS_PER_PROVIDER);
    if (env) entry.env = env;
    const baseUrl = trimmedOrUndefined(record.baseUrl);
    if (baseUrl) entry.baseUrl = baseUrl;
    const apiKey = trimmedOrUndefined(record.apiKey);
    if (apiKey) entry.apiKey = apiKey;
    if (record.apiKeyRedacted === true) entry.apiKeyRedacted = true;
    const timeout = optionalInteger(record.timeout);
    if (timeout !== undefined) entry.timeout = timeout;
    if (models.length > 0) entry.models = models;
    result[providerId] = entry as OpenCodeProviderSettings;
    if (Object.keys(result).length >= OPEN_CODE_MAX_PROVIDERS) break;
  }
  return result as OpenCodeProviderSettingsMap;
}

/** Resolved provider entry with its fields defaulted for editing. */
export interface OpenCodeProviderEntry {
  readonly providerId: string;
  readonly name?: string | undefined;
  readonly npm?: string | undefined;
  readonly env: ReadonlyArray<string>;
  readonly baseUrl?: string | undefined;
  readonly apiKey: string;
  readonly apiKeyRedacted: boolean;
  readonly timeout?: number | undefined;
  readonly models: ReadonlyArray<OpenCodeProviderModelSetting>;
}

/** Split a persisted map into editable entries, in a stable id-sorted order. */
export function openCodeProviderEntries(
  settings: OpenCodeProviderSettingsMap,
): OpenCodeProviderEntry[] {
  return Object.entries(settings)
    .map(([providerId, entry]) => ({
      providerId,
      name: entry.name,
      npm: entry.npm,
      env: entry.env ?? [],
      baseUrl: entry.baseUrl,
      apiKey: entry.apiKey ?? "",
      apiKeyRedacted: entry.apiKeyRedacted === true,
      timeout: entry.timeout,
      models: entry.models ?? [],
    }))
    .sort((left, right) => left.providerId.localeCompare(right.providerId));
}

/** Collapse an edited entry back into its persisted, sparse shape. */
export function toOpenCodeProviderSettings(entry: OpenCodeProviderEntry): OpenCodeProviderSettings {
  const models = entry.models.filter((model) => model.modelId.trim().length > 0);
  const result: Record<string, unknown> = {};
  if (entry.name?.trim()) result.name = entry.name.trim();
  if (entry.npm?.trim()) result.npm = entry.npm.trim();
  const env = trimmedList(entry.env);
  if (env) result.env = env;
  if (entry.baseUrl?.trim()) result.baseUrl = entry.baseUrl.trim();
  if (entry.apiKeyRedacted) {
    result.apiKeyRedacted = true;
  } else if (entry.apiKey.trim()) {
    result.apiKey = entry.apiKey.trim();
  }
  if (entry.timeout !== undefined) result.timeout = entry.timeout;
  if (models.length > 0) {
    // `modelId` is the key serialization writes into OpenCode's models map, so
    // it stays in the persisted entry.
    result.models = models;
  }
  return result as OpenCodeProviderSettings;
}

/**
 * Serialize one entry into OpenCode's `provider.<id>` shape. Model ids become
 * map keys, because OpenCode reads `models[modelId]` and only consults `id`
 * when the upstream id differs from the key.
 */
function toOpenCodeProviderConfig(entry: OpenCodeProviderEntry): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (entry.name?.trim()) config.name = entry.name.trim();
  if (entry.npm?.trim()) config.npm = entry.npm.trim();
  const env = trimmedList(entry.env);
  if (env) config.env = env;

  const options: Record<string, unknown> = {};
  if (entry.baseUrl?.trim()) options.baseURL = entry.baseUrl.trim();
  const apiKey = entry.apiKey.trim();
  if (apiKey) options.apiKey = apiKey;
  if (entry.timeout !== undefined) options.timeout = entry.timeout;
  if (Object.keys(options).length > 0) config.options = options;

  const models: Record<string, unknown> = {};
  for (const model of entry.models) {
    const modelId = model.modelId.trim();
    if (!modelId) continue;
    const payload: Record<string, unknown> = {};
    if (model.id?.trim()) payload.id = model.id.trim();
    if (model.name?.trim()) payload.name = model.name.trim();
    if (model.reasoning !== undefined) payload.reasoning = model.reasoning;
    if (model.attachment !== undefined) payload.attachment = model.attachment;
    if (model.temperature !== undefined) payload.temperature = model.temperature;
    if (model.toolCall !== undefined) payload.tool_call = model.toolCall;
    const limit: Record<string, number> = {};
    if (model.contextLimit !== undefined) limit.context = model.contextLimit;
    if (model.outputLimit !== undefined) limit.output = model.outputLimit;
    if (Object.keys(limit).length > 0) payload.limit = limit;
    if (model.status !== undefined) payload.status = model.status;
    const variants = trimmedList(model.variants);
    if (variants) {
      // OpenCode's `variants` map is keyed by level; an empty object means
      // "this level exists with default options".
      payload.variants = Object.fromEntries(variants.map((variant) => [variant, {}]));
    }
    models[modelId] = payload;
  }
  if (Object.keys(models).length > 0) config.models = models;
  return config;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseConfigContent(content: string | undefined): Record<string, unknown> {
  const trimmed = content?.trim();
  if (!trimmed || trimmed === OPENCODE_EMPTY_CONFIG_CONTENT) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    // A non-object document cannot carry a `provider` map, and OpenCode would
    // reject it anyway; treat it as empty so T3-managed entries still apply.
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Merge T3-managed providers into an existing `OPENCODE_CONFIG_CONTENT`
 * document. T3's entries win per provider id, and within an entry only the
 * fields the user actually set — so a hand-written config that OpenCode reads
 * from the environment keeps everything T3 does not manage.
 */
export function mergeOpenCodeProviderConfig(input: {
  readonly configContent?: string | undefined;
  readonly entries: ReadonlyArray<OpenCodeProviderEntry>;
}): string {
  const base = parseConfigContent(input.configContent);
  if (input.entries.length === 0) {
    return Object.keys(base).length > 0 ? JSON.stringify(base) : OPENCODE_EMPTY_CONFIG_CONTENT;
  }

  const baseProviders = isPlainObject(base.provider) ? base.provider : {};
  const providers: Record<string, unknown> = { ...baseProviders };
  let merged = 0;
  for (const entry of input.entries) {
    const providerId = entry.providerId.trim();
    if (!providerId || !OPEN_CODE_PROVIDER_ID_PATTERN.test(providerId)) continue;
    merged += 1;
    const managed = toOpenCodeProviderConfig(entry);
    const existing = isPlainObject(providers[providerId]) ? providers[providerId] : {};
    const existingOptions = isPlainObject(existing.options) ? existing.options : undefined;
    const existingModels = isPlainObject(existing.models) ? existing.models : undefined;
    const managedModels = isPlainObject(managed.models) ? managed.models : undefined;
    const options = isPlainObject(managed.options) ? managed.options : undefined;
    const mergedOptions = options ? { ...existingOptions, ...options } : existingOptions;
    providers[providerId] = {
      ...existing,
      ...managed,
      ...(mergedOptions && Object.keys(mergedOptions).length > 0 ? { options: mergedOptions } : {}),
      // A removed model must disappear from the merged document, so the
      // managed set replaces rather than extends when T3 manages the key.
      ...(managedModels ? { models: { ...existingModels, ...managedModels } } : {}),
    };
  }

  if (merged === 0) {
    return Object.keys(base).length > 0 ? JSON.stringify(base) : OPENCODE_EMPTY_CONFIG_CONTENT;
  }
  return JSON.stringify({ ...base, provider: providers });
}

/**
 * Project T3-managed providers onto the environment OpenCode is spawned with.
 * Returns the environment unchanged when nothing is configured, so an
 * unmanaged instance keeps whatever config the user already had.
 */
export function withOpenCodeProviderConfig(input: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly entries: ReadonlyArray<OpenCodeProviderEntry>;
  readonly inheritedEnvironment?: Readonly<Record<string, string | undefined>>;
}): Readonly<Record<string, string | undefined>> {
  if (input.entries.length === 0) return input.environment;
  const base =
    input.environment.OPENCODE_CONFIG_CONTENT ??
    input.inheritedEnvironment?.OPENCODE_CONFIG_CONTENT;
  return {
    ...input.environment,
    OPENCODE_CONFIG_CONTENT: mergeOpenCodeProviderConfig({
      configContent: base,
      entries: input.entries,
    }),
  };
}

// ── Validation ────────────────────────────────────────────────────────
// Shared so the Settings UI and any server-side check report the same thing.

export type OpenCodeValidationIssue = { readonly field: string; readonly message: string };

export function validateOpenCodeProviderId(value: string): OpenCodeValidationIssue | null {
  const id = value.trim();
  if (id.length === 0) return { field: "providerId", message: "Enter a provider id." };
  if (id.length > OPEN_CODE_MAX_PROVIDER_ID_LENGTH) {
    return {
      field: "providerId",
      message: `Provider ids must be ${OPEN_CODE_MAX_PROVIDER_ID_LENGTH} characters or less.`,
    };
  }
  if (!OPEN_CODE_PROVIDER_ID_PATTERN.test(id)) {
    return {
      field: "providerId",
      message:
        "Use letters, numbers, dots, dashes, or underscores, starting with a letter or number.",
    };
  }
  return null;
}

export function validateOpenCodeModelId(value: string): OpenCodeValidationIssue | null {
  const id = value.trim();
  if (id.length === 0) return { field: "modelId", message: "Enter a model id." };
  if (id.length > OPEN_CODE_MAX_MODEL_ID_LENGTH) {
    return {
      field: "modelId",
      message: `Model ids must be ${OPEN_CODE_MAX_MODEL_ID_LENGTH} characters or less.`,
    };
  }
  if (id.startsWith("/") || id.endsWith("/")) {
    return { field: "modelId", message: "Model ids cannot start or end with a slash." };
  }
  return null;
}

function validateOpenCodeNpmPackage(value: string): OpenCodeValidationIssue | null {
  const npm = value.trim();
  if (npm.length === 0) return null;
  if (npm.length > OPEN_CODE_MAX_NPM_LENGTH) {
    return {
      field: "npm",
      message: `Package names must be ${OPEN_CODE_MAX_NPM_LENGTH} characters or less.`,
    };
  }
  if (/\s/.test(npm)) {
    return { field: "npm", message: "Package names cannot contain spaces." };
  }
  return null;
}

export function validateOpenCodeBaseUrl(value: string): OpenCodeValidationIssue | null {
  const baseUrl = value.trim();
  if (baseUrl.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { field: "baseUrl", message: "Enter a full URL, such as https://api.example.com/v1." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { field: "baseUrl", message: "Base URLs must use http or https." };
  }
  return null;
}

/**
 * Validate a whole provider entry. Returns every issue so the editor can mark
 * each field at once rather than one round-trip per field.
 *
 * The one rule enforced here is the one OpenCode rejects the whole
 * configuration over: `limit` is only valid with both `context` and `output`.
 * Anything OpenCode merely ignores is left to OpenCode's own reporting, so
 * this never turns a working setup into a blocked save.
 */
export function validateOpenCodeProviderEntry(
  entry: OpenCodeProviderEntry,
): OpenCodeValidationIssue[] {
  const issues: OpenCodeValidationIssue[] = [];
  const providerIdIssue = validateOpenCodeProviderId(entry.providerId);
  if (providerIdIssue) issues.push(providerIdIssue);
  const npmIssue = validateOpenCodeNpmPackage(entry.npm ?? "");
  if (npmIssue) issues.push(npmIssue);
  const baseUrlIssue = validateOpenCodeBaseUrl(entry.baseUrl ?? "");
  if (baseUrlIssue) issues.push(baseUrlIssue);
  if (entry.models.length > OPEN_CODE_MAX_MODELS_PER_PROVIDER) {
    issues.push({
      field: "models",
      message: `A provider can define at most ${OPEN_CODE_MAX_MODELS_PER_PROVIDER} models.`,
    });
  }
  const seen = new Set<string>();
  for (const model of entry.models) {
    const issue = validateOpenCodeModelId(model.modelId);
    if (issue) {
      issues.push({ ...issue, message: `Model “${model.modelId}”: ${issue.message}` });
      continue;
    }
    if (seen.has(model.modelId)) {
      issues.push({
        field: "models",
        message: `Model “${model.modelId}” is listed twice.`,
      });
    }
    seen.add(model.modelId);
    // OpenCode rejects the whole document when only one half of `limit` is set.
    const hasContext = model.contextLimit !== undefined;
    const hasOutput = model.outputLimit !== undefined;
    if (hasContext !== hasOutput) {
      issues.push({
        field: "models",
        message: `Model “${model.modelId}”: set both a context window and a maximum output size, or neither.`,
      });
    }
  }
  return issues;
}
