import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import {
  SandboxProviderCredentialStore,
  SandboxProviderError,
} from "./SandboxProvider.ts";

/**
 * Server-backed sandbox provider credential store. API keys are stored via T3
 * Code's existing {@link ServerSecretStore} (filesystem-backed encrypted secrets
 * under the T3 home), referenced by `credentialKey` and never persisted in
 * ordinary project config, logs, repository files or URLs.
 */
const SECRET_PREFIX = "sandbox-provider/";

const toBytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const fromBytes = (value: Uint8Array): string => new TextDecoder().decode(value);

const mapSecretError = (operation: string, providerKind: string) =>
  Effect.mapError(
    (cause: unknown) =>
      new SandboxProviderError({
        providerKind,
        operation,
        detail: "Could not access the secure credential store.",
        cause: cause as never,
      }),
  );

export const makeSandboxCredentialStore = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  return SandboxProviderCredentialStore.of({
    get: (credentialKey, providerKind = "unknown") =>
      secrets.get(`${SECRET_PREFIX}${credentialKey}`).pipe(
        Effect.map(Option.match({ onNone: () => null, onSome: fromBytes })),
        Effect.flatMap((value) =>
          value === null
            ? Effect.fail(
                new SandboxProviderError({
                  providerKind,
                  operation: "get",
                  detail: "No API key is stored for this sandbox provider.",
                }),
              )
            : Effect.succeed(value),
        ),
        mapSecretError("get", providerKind),
      ),
    set: (credentialKey, secret, providerKind = "unknown") =>
      secrets.set(`${SECRET_PREFIX}${credentialKey}`, toBytes(secret)).pipe(mapSecretError("set", providerKind)),
    remove: (credentialKey, providerKind = "unknown") =>
      secrets.remove(`${SECRET_PREFIX}${credentialKey}`).pipe(mapSecretError("remove", providerKind)),
  });
});

export const sandboxCredentialStoreLayer = Layer.effect(
  SandboxProviderCredentialStore,
  makeSandboxCredentialStore,
);

/** Mask a secret for display/logs: show only the last 4 chars, never the full value. */
export function maskSecret(secret: string): string {
  if (secret.length <= 4) return "••••";
  return `••••${secret.slice(-4)}`;
}

/** Redacts known secret-looking strings from arbitrary text (logs, error output). */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  // Bearer/Authorization tokens
  /[Aa]uthorization:\s*Bearer\s+[A-Za-z0-9._\-]+/g,
  // Generic api_key=... / token=... / secret=... assignments
  /\b(?:api[_-]?key|token|secret|password|credential)\b\s*[:=]\s*["']?[A-Za-z0-9._\-]+["']?/gi,
  // https://user:pass@host credentials in URLs
  /:\/\/([^:/\s]+):([^@/\s]+)@/g,
  // GitHub PATs (ghp_, github_pat_) and fine-grained tokens
  /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
];

export function redactSecrets(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      // For URL credentials, preserve the host but mask the password.
      if (match.startsWith("://")) {
        return match.replace(/:([^@/\s]+)@/, ":••••@");
      }
      return "••••";
    });
  }
  return redacted;
}

/** Schema-less helper for tests/inspectors that need to assert masking behavior. */
export const MaskedSecret = Schema.String;
export type MaskedSecret = typeof MaskedSecret.Type;
