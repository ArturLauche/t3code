from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one match in {path}, found {count}: {old[:120]!r}")
    file.write_text(text.replace(old, new, 1))


# Propagate the authenticated WebSocket session into RPC handlers so GitHub credentials
# remain scoped to the session that injected them.
replace_once(
    "apps/server/src/ws.ts",
    '''  EnvironmentAuthorizationError,\n  ThreadId,''',
    '''  EnvironmentAuthorizationError,\n  EnvironmentAuthenticatedPrincipal,\n  ThreadId,''',
)
replace_once(
    "apps/server/src/ws.ts",
    '''        const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {''',
    '''        const authenticatedPrincipal = {
          sessionId: session.sessionId,
          subject: session.subject,
          method: session.method,
          scopes: new Set(session.scopes),
          ...(session.proofKeyThumbprint === undefined
            ? {}
            : { proofKeyThumbprint: session.proofKeyThumbprint }),
          ...(session.expiresAt === undefined ? {} : { expiresAt: session.expiresAt }),
        };
        const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsRpcGroup, {''',
)
replace_once(
    "apps/server/src/ws.ts",
    '''          () => rpcWebSocketHttpEffect,''',
    '''          () =>
            rpcWebSocketHttpEffect.pipe(
              Effect.provideService(EnvironmentAuthenticatedPrincipal, authenticatedPrincipal),
            ),''',
)

# Preserve startup failures for polling and reset stale terminal state when starting again.
replace_once(
    "packages/github/src/deviceFlow.ts",
    '''  private starting: Promise<GitHubDeviceFlowAuthorization> | null = null;
  private readonly options: GitHubDeviceFlowOptions;''',
    '''  private starting: Promise<GitHubDeviceFlowAuthorization> | null = null;
  private lastError: unknown | null = null;
  private readonly options: GitHubDeviceFlowOptions;''',
)
replace_once(
    "packages/github/src/deviceFlow.ts",
    '''    if (this.starting !== null) {
      return this.starting;
    }

    let verificationReceived = false;''',
    '''    if (this.starting !== null) {
      return this.starting;
    }

    this.pending = null;
    this.lastError = null;
    let verificationReceived = false;''',
)
replace_once(
    "packages/github/src/deviceFlow.ts",
    '''      () => {
        if (this.starting === starting) this.starting = null;
      },
      () => {
        if (this.starting === starting) this.starting = null;
      },''',
    '''      () => {
        if (this.starting === starting) this.starting = null;
      },
      (error: unknown) => {
        if (this.starting === starting) this.starting = null;
        this.lastError = error;
      },''',
)
replace_once(
    "packages/github/src/deviceFlow.ts",
    '''    return (
      this.pending?.state ?? { status: "error", error: new Error("No device flow is active.") }
    );''',
    '''    return (
      this.pending?.state ??
      (this.lastError === null
        ? { status: "error", error: new Error("No device flow is active.") }
        : { status: "error", error: this.lastError })
    );''',
)
replace_once(
    "packages/github/src/deviceFlow.ts",
    '''    this.pending = null;
    this.starting = null;''',
    '''    this.pending = null;
    this.starting = null;
    this.lastError = null;''',
)
replace_once(
    "packages/github/src/deviceFlow.test.ts",
    '''    await expect(flow.start()).rejects.toThrow("device flow unavailable");
    expect(flow.poll()).toMatchObject({ status: "error" });''',
    '''    await expect(flow.start()).rejects.toThrow("device flow unavailable");
    expect(flow.poll()).toMatchObject({
      status: "error",
      error: expect.objectContaining({ message: "device flow unavailable" }),
    });''',
)

# Do not serialize optional credential-sync failure objects into logs.
replace_once(
    "packages/client-runtime/src/connection/resolver.ts",
    '''          Effect.logWarning("Could not synchronize optional source-control credentials.", {
            cause,
            environmentId: prepared.target.environmentId,
          }),''',
    '''          Effect.logWarning("Could not synchronize optional source-control credentials.", {
            reason: typeof cause === "object" && cause !== null && "_tag" in cause
              ? String(cause._tag)
              : "unknown",
            environmentId: prepared.target.environmentId,
          }),''',
)

# Refresh after both complete and partial disconnects so the UI cannot remain falsely connected.
replace_once(
    "apps/web/src/components/settings/GitHubConnectionSettings.tsx",
    '''    } catch (cause) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not disconnect GitHub",
          description: message(cause),
        }),
      );
    } finally {
      setPending(false);
    }''',
    '''    } catch (cause) {
      await refresh().catch(() => undefined);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "GitHub disconnected with a warning",
          description: message(cause),
        }),
      );
    } finally {
      setPending(false);
    }''',
)

# Treat registration of the optional GitHub bridge as best effort after a successful SSH login.
ssh = Path("apps/desktop/src/ipc/methods/sshEnvironment.ts")
text = ssh.read_text()
old = '''    const descriptor = yield* withLoopbackSshApi(
      "fetch-environment-descriptor",
      (resolvedHttpBaseUrl) =>
        fetchRemoteEnvironmentDescriptor({ httpBaseUrl: resolvedHttpBaseUrl }),
    )(httpBaseUrl);
    const resolvedHttpBaseUrl = yield* resolveLoopbackSshHttpBaseUrl(httpBaseUrl).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopSshEnvironmentRequestError({
            operation: "bootstrap-bearer-session",
            cause,
            sshHttpStatus: readSshHttpStatus(cause),
          }),
      ),
    );
    yield* github.registerTrustedEnvironment({
      environmentId: descriptor.environmentId,
      httpBaseUrl: resolvedHttpBaseUrl,
      accessToken: access.access_token,
    });'''
new = '''    yield* withLoopbackSshApi(
      "register-github-environment",
      (resolvedHttpBaseUrl) =>
        Effect.gen(function* () {
          const descriptor = yield* fetchRemoteEnvironmentDescriptor({
            httpBaseUrl: resolvedHttpBaseUrl,
          });
          yield* github.registerTrustedEnvironment({
            environmentId: descriptor.environmentId,
            httpBaseUrl: resolvedHttpBaseUrl,
            accessToken: access.access_token,
          });
        }),
    )(httpBaseUrl).pipe(
      Effect.catch(() =>
        Effect.logWarning("Could not register the optional GitHub credential bridge for SSH.", {
          reason: "registration-failed",
        }),
      ),
    );'''
if text.count(old) != 1:
    raise RuntimeError(f"SSH registration block count was {text.count(old)}")
ssh.write_text(text.replace(old, new, 1))

# Drop trusted targets after refresh failures so closed tunnels/sandboxes do not remain in memory forever,
# and distinguish partial remote revocation from a local disconnect failure.
replace_once(
    "apps/desktop/src/github/DesktopGitHubIntegration.ts",
    '''          Effect.catch((error) =>
            Effect.logWarning("Could not refresh a synchronized GitHub credential.", {
              environmentId,
              operation: error.operation,
            }),
          ),''',
    '''          Effect.catch((error) =>
            Ref.update(trustedEnvironments, (current) => {
              const next = new Map(current);
              next.delete(environmentId);
              return next;
            }).pipe(
              Effect.andThen(
                Effect.logWarning("Could not refresh a synchronized GitHub credential.", {
                  environmentId,
                  operation: error.operation,
                }),
              ),
            ),
          ),''',
)
replace_once(
    "apps/desktop/src/github/DesktopGitHubIntegration.ts",
    '''          "disconnect",
          `GitHub was disconnected locally, but ${failedRevocations} remote credential ${failedRevocations === 1 ? "copy" : "copies"} could not be revoked immediately and will expire automatically.`,''',
    '''          "disconnect-remote-revocation",
          `GitHub was disconnected locally, but ${failedRevocations} remote credential ${failedRevocations === 1 ? "copy" : "copies"} could not be revoked immediately and will expire automatically.`,''',
)

# Stabilize repository-picker callback identity used from a memoized group.
replace_once(
    "apps/web/src/components/CommandPalette.tsx",
    '''  function continueWithGitHubRepository(
    repository: Pick<GitHubRepositorySummary, "nameWithOwner" | "url" | "sshUrl" | "cloneUrl">,
  ): void {
    if (addProjectCloneFlow?.step !== "repository") return;
    const destinationPath = getDefaultCloneParentPath(addProjectCloneFlow.environmentId);
    const selection = githubRepositoryCloneSelection(repository);
    setAddProjectCloneFlow({
      step: "confirm",
      environmentId: addProjectCloneFlow.environmentId,
      source: "github",
      repositoryInput: repository.nameWithOwner,
      repository: selection.repository,
      remoteUrl: selection.remoteUrl,
    });
    setHighlightedItemValue(null);
    setQuery(destinationPath);
    setBrowseGeneration((generation) => generation + 1);
  }''',
    '''  const continueWithGitHubRepository = useCallback(
    (
      repository: Pick<GitHubRepositorySummary, "nameWithOwner" | "url" | "sshUrl" | "cloneUrl">,
    ): void => {
      if (addProjectCloneFlow?.step !== "repository") return;
      const destinationPath = getDefaultCloneParentPath(addProjectCloneFlow.environmentId);
      const selection = githubRepositoryCloneSelection(repository);
      setAddProjectCloneFlow({
        step: "confirm",
        environmentId: addProjectCloneFlow.environmentId,
        source: "github",
        repositoryInput: repository.nameWithOwner,
        repository: selection.repository,
        remoteUrl: selection.remoteUrl,
      });
      setHighlightedItemValue(null);
      setQuery(destinationPath);
      setBrowseGeneration((generation) => generation + 1);
    },
    [addProjectCloneFlow, getAddProjectInitialQueryForEnvironment],
  );''',
)
replace_once(
    "apps/web/src/components/CommandPalette.tsx",
    '''    [addProjectCloneFlow, githubConnection, githubRepositories],''',
    '''    [addProjectCloneFlow, continueWithGitHubRepository, githubConnection, githubRepositories],''',
)

# Keep user docs focused on product behavior and point fork builders to operator docs.
replace_once(
    "docs/user/github-connection.md",
    '''For a fork build, set the `T3CODE_GITHUB_CLIENT_ID` GitHub Actions repository variable. Do not add a
GitHub OAuth client secret to a desktop build.''',
    '''If you build T3 Code from a fork, follow the [fork build guide](../operations/fork-builds.md) for
GitHub connection configuration. Do not add a GitHub OAuth client secret to a desktop build.''',
)

# Add the new execution-environment terms required by the repository glossary policy.
glossary = Path("docs/internals/glossary.md")
text = glossary.read_text()
text = text.replace(
    '''- [Project and workspace](#project-and-workspace)\n- [Thread timeline](#thread-timeline)''',
    '''- [Project and workspace](#project-and-workspace)\n- [Execution environments](#execution-environments)\n- [Thread timeline](#thread-timeline)''',
    1,
)
marker = '''### Thread timeline\n'''
addition = '''### Execution environments

#### Execution environment

The machine or managed sandbox that owns a T3 server and therefore owns project files, terminals, Git operations, and agent processes. A project is always routed through one execution environment.

#### Local

An execution environment managed directly by the desktop app on the current machine, including the primary local backend and supported local platform backends such as WSL.

#### SSH Remote

An execution environment reached through SSH. The desktop manages the SSH transport while the remote T3 server remains responsible for projects, Git, terminals, and agents on that host.

#### Cloud Sandbox

A provider-managed execution environment such as Daytona, E2B, or Novita. T3 normalizes provider lifecycle operations and connects to a T3 server running inside the sandbox.

'''
if text.count(marker) != 1:
    raise RuntimeError("Glossary thread marker was not unique")
glossary.write_text(text.replace(marker, addition + marker, 1))
