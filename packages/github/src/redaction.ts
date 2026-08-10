const SECRET_KEY_PATTERN = /(token|authorization|password|secret|api[-_]?key)/iu;

export function redactGitHubSecrets(value: unknown, knownSecrets: readonly string[] = []): unknown {
  const secrets = knownSecrets.filter((secret) => secret.length > 0);
  const redactString = (input: string): string => {
    let result = input;
    for (const secret of secrets) {
      result = result.replaceAll(secret, "[REDACTED]");
    }
    return result.replace(/(gh[opsu]_[A-Za-z0-9_]{12,})/gu, "[REDACTED]");
  };
  const visit = (input: unknown): unknown => {
    if (typeof input === "string") return redactString(input);
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
