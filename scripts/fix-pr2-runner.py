from pathlib import Path

path = Path("scripts/pr2-final-source.py")
text = path.read_text()

vcs_process_old = '''    const githubEnvironment =
      Option.isSome(githubBroker) && (input.command === "git" || input.command === "gh")
        ? yield* (input.command === "gh"
            ? githubBroker.value.cliEnvironment
            : githubBroker.value.processEnvironment
          ).pipe('''
vcs_process_new = '''    const githubEnvironment =
      Option.isSome(githubBroker) && (input.command === "git" || input.command === "gh")
        ? yield* (
            input.command === "gh"
              ? githubBroker.value.cliEnvironment
              : githubBroker.value.processEnvironment
          ).pipe('''
if text.count(vcs_process_old) != 1:
    raise RuntimeError(f"VcsProcess expected-block patch count was {text.count(vcs_process_old)}")
text = text.replace(vcs_process_old, vcs_process_new, 1)

core_old = '''          const githubEnvironment = Option.isSome(githubBroker)
            ? yield* githubBroker.value.processEnvironment.pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Could not prepare ephemeral GitHub credentials.", {
                    operation: error.operation,
                  }).pipe(Effect.as(Option.none<NodeJS.ProcessEnv>())),
                ),
              )
            : Option.none<NodeJS.ProcessEnv>();'''
core_live = '''        const githubEnvironment = Option.isSome(githubBroker)
          ? yield* githubBroker.value.processEnvironment.pipe(
              Effect.catch((error) =>
                Effect.logWarning("Could not prepare ephemeral GitHub credentials.", {
                  operation: error.operation,
                }).pipe(Effect.as(Option.none<NodeJS.ProcessEnv>())),
              ),
            )
          : Option.none<NodeJS.ProcessEnv>();'''
if text.count(core_old) != 1:
    raise RuntimeError(f"GitVcsDriverCore expected-block patch count was {text.count(core_old)}")
text = text.replace(core_old, core_live, 1)

core_new_old = '''          const githubLease = Option.isSome(githubBroker)
            ? yield* Effect.acquireRelease(
                githubBroker.value.gitProcessEnvironment.pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("Could not prepare ephemeral GitHub credentials.", {
                      operation: error.operation,
                    }).pipe(
                      Effect.as(Option.none<GitHubCredentialBroker.GitHubGitEnvironmentLease>()),
                    ),
                  ),
                ),
                (lease) => (Option.isSome(lease) ? lease.value.release : Effect.void),
              )
            : Option.none<GitHubCredentialBroker.GitHubGitEnvironmentLease>();'''
core_new_live = '''        const githubLease = Option.isSome(githubBroker)
          ? yield* Effect.acquireRelease(
              githubBroker.value.gitProcessEnvironment.pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Could not prepare ephemeral GitHub credentials.", {
                    operation: error.operation,
                  }).pipe(
                    Effect.as(Option.none<GitHubCredentialBroker.GitHubGitEnvironmentLease>()),
                  ),
                ),
              ),
              (lease) => (Option.isSome(lease) ? lease.value.release : Effect.void),
            )
          : Option.none<GitHubCredentialBroker.GitHubGitEnvironmentLease>();'''
if text.count(core_new_old) != 1:
    raise RuntimeError(f"GitVcsDriverCore replacement-block patch count was {text.count(core_new_old)}")
text = text.replace(core_new_old, core_new_live, 1)

path.write_text(text)
