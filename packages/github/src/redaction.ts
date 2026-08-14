const SECRET_KEY_PATTERN = /(token|authorization|password|secret|api[-_]?key)/iu;
const SECRET_VALUE_PATTERN = /(gh[opsu]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})/gu;

export function redactGitHubSecrets(value: unknown, knownSecrets: readonly string[] = []): unknown {
  const secrets = knownSecrets.filter((secret) => secret.length > 0);
  const redactString = (input: string): string => {
    let result = input;
    for (const secret of secrets) {
      result = result.replaceAll(secret, "[REDACTED]");
    }
    return result.replace(SECRET_VALUE_PATTERN, "[REDACTED]");
  };
  const visit = (input: unknown): unknown => {
    if (typeof input === "string") return redactString(input);
    if (input instanceof Error) return redactString(input.message);
    if (Array.isArray(input)) return input.map(visit);
    if (typeof input !== "object" || input === null) return input;
    return Object.fromEntries(
      Object.entries(input).map(([key, child]) => [
        key,
        SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : visit(child),
      ]),
    );
  };
  return visit(value);
}
