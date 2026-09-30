import type {
  OpenCodeProviderModelSetting,
  OpenCodeProviderSettingsMap,
  ServerProviderModel,
} from "@t3tools/contracts";
import {
  type OpenCodeProviderEntry,
  type OpenCodeValidationIssue,
  openCodeProviderEntries,
  readOpenCodeProviderSettings,
  toOpenCodeProviderSettings,
  validateOpenCodeProviderEntry,
} from "@t3tools/shared/openCodeProviderConfig";

/**
 * Logic behind the OpenCode providers editor.
 *
 * Kept out of the component so the parts worth asserting on — what OpenCode
 * reported, how a draft becomes a persisted map, which edits are rejected —
 * can be tested without rendering.
 */

/**
 * One upstream provider as OpenCode reported it.
 *
 * T3 model slugs are `<providerID>/<modelID>`, so the provider inventory is
 * recoverable from the model list the picker already renders. Only connected
 * providers reach the picker, which is exactly the set worth showing here.
 */
export interface DiscoveredOpenCodeProvider {
  readonly providerId: string;
  readonly name: string;
  readonly modelIds: ReadonlyArray<string>;
}

export function discoverOpenCodeProviders(
  models: ReadonlyArray<ServerProviderModel>,
): DiscoveredOpenCodeProvider[] {
  const byProviderId = new Map<string, { name: string; modelIds: string[] }>();
  for (const model of models) {
    const separator = model.slug.indexOf("/");
    if (separator <= 0 || separator === model.slug.length - 1) continue;
    const providerId = model.slug.slice(0, separator);
    const modelId = model.slug.slice(separator + 1);
    const existing = byProviderId.get(providerId) ?? { name: providerId, modelIds: [] };
    // `subProvider` is OpenCode's own display name for the provider.
    if (model.subProvider) existing.name = model.subProvider;
    existing.modelIds.push(modelId);
    byProviderId.set(providerId, existing);
  }
  return [...byProviderId.entries()]
    .map(([providerId, entry]) => ({ providerId, name: entry.name, modelIds: entry.modelIds }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Read the provider map out of the opaque per-instance config blob. */
export function readInstanceOpenCodeProviders(config: unknown): OpenCodeProviderSettingsMap {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return {};
  return readOpenCodeProviderSettings((config as Record<string, unknown>).providers);
}

/** Every problem with a provider draft, so the editor can mark each field at once. */
export function openCodeProviderIssues(
  entry: OpenCodeProviderEntry,
): ReadonlyArray<OpenCodeValidationIssue> {
  return validateOpenCodeProviderEntry(entry);
}

export function newOpenCodeProviderEntry(providerId: string, name?: string): OpenCodeProviderEntry {
  return {
    providerId: providerId.trim(),
    ...(name?.trim() ? { name: name.trim() } : {}),
    env: [],
    apiKey: "",
    apiKeyRedacted: false,
    models: [],
  };
}

export function newOpenCodeModelEntry(modelId: string): OpenCodeProviderModelSetting {
  return { modelId: modelId.trim() };
}

export function upsertOpenCodeProvider(
  providers: OpenCodeProviderSettingsMap,
  entry: OpenCodeProviderEntry,
): OpenCodeProviderSettingsMap {
  return {
    ...providers,
    [entry.providerId.trim()]: toOpenCodeProviderSettings(entry),
  };
}

export function withoutOpenCodeProvider(
  providers: OpenCodeProviderSettingsMap,
  providerId: string,
): OpenCodeProviderSettingsMap {
  const { [providerId]: _removed, ...rest } = providers;
  return rest;
}

export function withOpenCodeProviderModel(
  entry: OpenCodeProviderEntry,
  model: OpenCodeProviderModelSetting,
): OpenCodeProviderEntry {
  const modelId = model.modelId.trim();
  return {
    ...entry,
    // Editing a model replaces the row with the same id rather than adding one.
    models: [...entry.models.filter((candidate) => candidate.modelId !== modelId), model],
  };
}

export function withoutOpenCodeProviderModel(
  entry: OpenCodeProviderEntry,
  modelId: string,
): OpenCodeProviderEntry {
  return { ...entry, models: entry.models.filter((model) => model.modelId !== modelId) };
}

export function findOpenCodeProviderEntry(
  providers: OpenCodeProviderSettingsMap,
  providerId: string,
): OpenCodeProviderEntry | undefined {
  return openCodeProviderEntries(providers).find((entry) => entry.providerId === providerId);
}

/** Short capability words for a model row, mirroring the Models section. */
export function describeOpenCodeModel(model: OpenCodeProviderModelSetting): string[] {
  const labels: string[] = [];
  if (model.reasoning) labels.push("Reasoning");
  if (model.attachment) labels.push("Images");
  if (model.toolCall) labels.push("Tools");
  if (model.temperature) labels.push("Temperature");
  if (model.contextLimit) labels.push(`${Math.round(model.contextLimit / 1000)}k context`);
  return labels;
}

/** Whether OpenCode already reports this model, i.e. saving only refines it. */
export function isModelReportedByOpenCode(input: {
  readonly providerId: string;
  readonly modelId: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
}): boolean {
  return input.models.some((model) => model.slug === `${input.providerId}/${input.modelId}`);
}

/**
 * Write the provider map back onto the opaque instance config, leaving every
 * other driver setting untouched.
 */
export function withInstanceOpenCodeProviders(
  config: unknown,
  providers: OpenCodeProviderSettingsMap,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    config !== null && typeof config === "object" && !Array.isArray(config)
      ? { ...(config as Record<string, unknown>) }
      : {};
  if (Object.keys(providers).length === 0) {
    delete base.providers;
    return base;
  }
  base.providers = providers;
  return base;
}
