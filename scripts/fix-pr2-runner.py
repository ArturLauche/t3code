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

ambiguous_provider_refresh = '''replace_once(
    "apps/web/src/components/settings/CloudSandboxesSettings.tsx",
    \'\'\'      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>\'\'\',
    \'\'\'      setError(errorMessage(cause));
      await onSaved().catch(() => undefined);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>\'\'\',
)
'''
if text.count(ambiguous_provider_refresh) != 1:
    raise RuntimeError(
        f"Cloud provider ambiguous refresh patch count was {text.count(ambiguous_provider_refresh)}"
    )
text = text.replace(ambiguous_provider_refresh, "", 1)

# curl returns success for HTTP 4xx by default, matching the previous node probe's <500 health rule.
text = text.replace(
    'curl --fail --silent --max-time 1 "http://127.0.0.1:$PORT/"',
    'curl --silent --max-time 1 -o /dev/null "http://127.0.0.1:$PORT/"',
)
path.write_text(text)

cloud_path = Path("apps/web/src/components/settings/CloudSandboxesSettings.tsx")
cloud = cloud_path.read_text()
provider_failure_old = '''    } catch (cause) {
      if (savedConnection) {
        await bridge
          .removeCloudSandboxProviderConnection({ id: savedConnection.id })
          .catch(() => undefined);
      }
      setError(errorMessage(cause));
    } finally {'''
provider_failure_new = '''    } catch (cause) {
      if (savedConnection) {
        await bridge
          .removeCloudSandboxProviderConnection({ id: savedConnection.id })
          .catch(() => undefined);
        await onSaved().catch(() => undefined);
      }
      setError(errorMessage(cause));
    } finally {'''
if cloud.count(provider_failure_old) != 1:
    raise RuntimeError(f"Provider failure refresh source count was {cloud.count(provider_failure_old)}")
cloud_path.write_text(cloud.replace(provider_failure_old, provider_failure_new, 1))
