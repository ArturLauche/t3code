/**
 * User-supplied OpenCode provider and model configuration.
 *
 * These schemas are a faithful, narrowed projection of OpenCode's own
 * `provider.<id>` config (`Config.provider` in the OpenCode schema). T3 Code
 * does not invent a second configuration language: entries written here are
 * serialized into the same JSON shape OpenCode reads from
 * `OPENCODE_CONFIG_CONTENT`, and OpenCode remains the component that resolves
 * providers, loads their `@ai-sdk/*` packages, and reports which models are
 * connected. T3 Code only persists the entries and re-probes.
 *
 * Field names follow OpenCode's camelCase (`baseUrl` → `options.baseURL`,
 * `toolCall` → `tool_call`) so the mapping stays obvious against upstream.
 */
import * as Schema from "effect/Schema";

import {
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

/**
 * OpenCode provider ids double as the `providerID` half of a T3 model slug
 * (`<providerID>/<modelID>`) and as `provider.<id>` config keys, so they are
 * restricted to a conservative slug.
 */
export const OPEN_CODE_PROVIDER_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
export const OPEN_CODE_MAX_PROVIDER_ID_LENGTH = 64;
/** npm package specifier, e.g. `@ai-sdk/openai-compatible` or `my-provider@1.2.3`. */
export const OPEN_CODE_MAX_NPM_LENGTH = 214;
export const OPEN_CODE_MAX_MODEL_ID_LENGTH = 256;
export const OPEN_CODE_MAX_MODEL_VARIANTS = 16;
export const OPEN_CODE_MAX_PROVIDERS = 128;
export const OPEN_CODE_MAX_MODELS_PER_PROVIDER = 256;
export const OPEN_CODE_MAX_ENV_VARS_PER_PROVIDER = 8;

export const OpenCodeProviderId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(OPEN_CODE_MAX_PROVIDER_ID_LENGTH),
  Schema.isPattern(OPEN_CODE_PROVIDER_ID_PATTERN),
);
export type OpenCodeProviderId = typeof OpenCodeProviderId.Type;

/**
 * OpenCode model ids may contain `/` (OpenRouter publishes `vendor/model`);
 * T3 Code splits a composite slug on the first `/` only. Leading and trailing
 * separators would produce an unparseable slug, so they are rejected.
 */
export const OpenCodeModelId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(OPEN_CODE_MAX_MODEL_ID_LENGTH),
  Schema.isPattern(/^[^\s/].*[^\s/]$|^[^\s/]$/),
);
export type OpenCodeModelId = typeof OpenCodeModelId.Type;

/** Environment variable names OpenCode reads a provider key from. */
export const OpenCodeEnvironmentVariableName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
);
export type OpenCodeEnvironmentVariableName = typeof OpenCodeEnvironmentVariableName.Type;

/**
 * One user-declared model inside a provider entry. Mirrors OpenCode's
 * `provider.<id>.models.<modelId>`: an entry with no other fields set is
 * already meaningful to OpenCode ("this model exists on this provider"), so
 * every other field is optional.
 *
 * Models are stored as an ordered list rather than OpenCode's object map
 * because T3 Code edits them positionally; `modelId` is the map key that
 * serialization writes.
 */
export const OpenCodeProviderModelSetting = Schema.Struct({
  modelId: OpenCodeModelId,
  /** Upstream model id, when it differs from the key used in the config map. */
  id: Schema.optionalKey(TrimmedNonEmptyString),
  /** Display name shown in OpenCode's own TUI and surfaced by T3's picker. */
  name: Schema.optionalKey(TrimmedNonEmptyString),
  reasoning: Schema.optionalKey(Schema.Boolean),
  attachment: Schema.optionalKey(Schema.Boolean),
  temperature: Schema.optionalKey(Schema.Boolean),
  toolCall: Schema.optionalKey(Schema.Boolean),
  /** `limit.context` — the model's total context window in tokens. */
  contextLimit: Schema.optionalKey(NonNegativeInt),
  /** `limit.output` — maximum tokens the model may emit. */
  outputLimit: Schema.optionalKey(PositiveInt),
  status: Schema.optionalKey(Schema.Literals(["alpha", "beta", "deprecated", "active"])),
  /**
   * Reasoning levels the model supports. OpenCode stores these as
   * `variants.<name> = {}`; T3 Code projects them onto the `variant` select
   * the composer already renders.
   */
  variants: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
});
export type OpenCodeProviderModelSetting = typeof OpenCodeProviderModelSetting.Type;

/**
 * One user-supplied OpenCode provider. `apiKey` is a secret: the server moves
 * it into the secret store and leaves `apiKeyRedacted: true` behind in
 * settings, mirroring `ProviderInstanceEnvironmentVariable.valueRedacted`.
 */
export const OpenCodeProviderSettings = Schema.Struct({
  /** Display name OpenCode shows instead of the provider id. */
  name: Schema.optionalKey(TrimmedNonEmptyString),
  /** `@ai-sdk/*` package (or a local path) used to talk to this provider. */
  npm: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(OPEN_CODE_MAX_NPM_LENGTH)),
  ),
  /**
   * Environment variable names that may hold the key. OpenCode's own idiom for
   * keeping credentials out of config files; useful alongside an `apiKey` when
   * the value already exists in the environment.
   */
  env: Schema.optionalKey(
    Schema.Array(OpenCodeEnvironmentVariableName).check(
      Schema.isMaxLength(OPEN_CODE_MAX_ENV_VARS_PER_PROVIDER),
    ),
  ),
  /** `options.baseURL` — override the upstream endpoint (relays, self-hosting). */
  baseUrl: Schema.optionalKey(TrimmedString),
  /** Empty together with `apiKeyRedacted`: the key lives in the secret store. */
  apiKey: Schema.optionalKey(TrimmedString),
  apiKeyRedacted: Schema.optionalKey(Schema.Boolean),
  /** `options.timeout` in milliseconds. */
  timeout: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600_000 }))),
  models: Schema.optionalKey(
    Schema.Array(OpenCodeProviderModelSetting).check(
      Schema.isMaxLength(OPEN_CODE_MAX_MODELS_PER_PROVIDER),
    ),
  ),
});
export type OpenCodeProviderSettings = typeof OpenCodeProviderSettings.Type;

export const OpenCodeProviderSettingsMap = Schema.Record(
  OpenCodeProviderId,
  OpenCodeProviderSettings,
).check(Schema.isMaxProperties(OPEN_CODE_MAX_PROVIDERS));
export type OpenCodeProviderSettingsMap = typeof OpenCodeProviderSettingsMap.Type;
