"use client";

import {
  CloudRuntimeId,
  type CloudRuntimeConfig,
  type CloudRuntimeInstance,
  type CloudRuntimeKind,
  type EnvironmentId,
} from "@t3tools/contracts";
import { PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const RUNTIME_KINDS: ReadonlyArray<{ value: CloudRuntimeKind; label: string }> = [
  { value: "e2b", label: "E2B" },
  { value: "novita", label: "Novita" },
  { value: "daytona", label: "Daytona" },
];

const RUNTIME_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const isValidRuntimeId = (value: string): boolean =>
  RUNTIME_ID_PATTERN.test(value) && value !== "local";
const isValidCloudApiUrl = (value: string): boolean =>
  value.trim() === "" || /^https:\/\/[^\s/?#@]+(?:\/[^\s?#]*)?$/u.test(value.trim());

type RuntimeConfigPatch = Partial<{
  kind: CloudRuntimeKind;
  displayName: string;
  enabled: boolean;
  region: string;
  template: string;
  domain: string;
  apiUrl: string;
  autoPauseMinutes: number | null;
  setupCommands: ReadonlyArray<string>;
}>;

function optionalText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const runtimeConnectionFingerprint = (config: CloudRuntimeConfig): string =>
  JSON.stringify([
    config.kind,
    config.enabled,
    config.region ?? null,
    config.template ?? null,
    config.domain ?? null,
    config.apiUrl ?? null,
    config.autoPauseMinutes ?? null,
    config.setupCommands,
  ]);

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function mergeRuntimeConfig(
  current: CloudRuntimeConfig,
  patch: RuntimeConfigPatch,
): CloudRuntimeConfig {
  return withoutUndefined({
    ...current,
    ...patch,
    ...(patch.displayName !== undefined ? { displayName: optionalText(patch.displayName) } : {}),
    ...(patch.region !== undefined ? { region: optionalText(patch.region) } : {}),
    ...(patch.template !== undefined ? { template: optionalText(patch.template) } : {}),
    ...(patch.domain !== undefined ? { domain: optionalText(patch.domain) } : {}),
    ...(patch.apiUrl !== undefined ? { apiUrl: optionalText(patch.apiUrl) } : {}),
    ...(patch.autoPauseMinutes !== undefined
      ? { autoPauseMinutes: patch.autoPauseMinutes ?? undefined }
      : {}),
  }) as CloudRuntimeConfig;
}

function runtimeLabel(runtime: CloudRuntimeInstance): string {
  return runtime.config.displayName?.trim() || runtime.id;
}

function healthLabel(runtime: CloudRuntimeInstance): string {
  if (runtime.health.message) return runtime.health.message;
  switch (runtime.health.status) {
    case "ready":
      return "Ready";
    case "unconfigured":
      return "Add an API key to configure this runtime.";
    case "disabled":
      return "Disabled";
    case "error":
      return "The last health check failed.";
    default:
      return "Checking runtime…";
  }
}

export function CloudRuntimeSettings({
  environmentId,
  readOnly = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly readOnly?: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const listRuntimes = useAtomCommand(serverEnvironment.cloudRuntimeList, { reportFailure: true });
  const setCredential = useAtomCommand(serverEnvironment.cloudRuntimeSetCredential, {
    reportFailure: true,
  });
  const clearCredential = useAtomCommand(serverEnvironment.cloudRuntimeClearCredential, {
    reportFailure: true,
  });
  const testRuntime = useAtomCommand(serverEnvironment.cloudRuntimeTest, { reportFailure: true });
  const createSandbox = useAtomCommand(serverEnvironment.cloudRuntimeCreateSandbox, {
    reportFailure: true,
  });
  const listSandboxes = useAtomCommand(serverEnvironment.cloudRuntimeListSandboxes, {
    reportFailure: true,
  });
  const sandboxAction = useAtomCommand(serverEnvironment.cloudRuntimeSandboxAction, {
    reportFailure: true,
  });
  const [runtimes, setRuntimes] = useState<ReadonlyArray<CloudRuntimeInstance>>([]);
  const [newRuntimeId, setNewRuntimeId] = useState("");
  const [apiKeys, setApiKeys] = useState<Readonly<Record<string, string>>>({});
  const [apiUrlDrafts, setApiUrlDrafts] = useState<Readonly<Record<string, string>>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const refreshGeneration = useRef(0);

  useEffect(() => {
    // Runtime ids are scoped to an environment; never carry credentials or
    // health state across an environment switch.
    setRuntimes([]);
    setApiKeys({});
    setApiUrlDrafts({});
    setBusyId(null);
  }, [environmentId]);

  const refresh = useCallback(async () => {
    const generation = refreshGeneration.current + 1;
    refreshGeneration.current = generation;
    const result = await listRuntimes({ environmentId, input: {} });
    if (generation === refreshGeneration.current && result._tag === "Success") {
      setRuntimes(result.value.runtimes);
    }
  }, [environmentId, listRuntimes]);

  useEffect(() => {
    void refresh();
    return () => {
      refreshGeneration.current += 1;
    };
  }, [refresh]);

  const configuredRuntimes = settings.cloudRuntimeInstances;
  const updateRuntime = useCallback(
    (id: CloudRuntimeId, patch: RuntimeConfigPatch) => {
      const current = configuredRuntimes[id];
      if (!current) return;
      updateSettings({
        cloudRuntimeInstances: {
          [id]: mergeRuntimeConfig(current, patch),
        },
      });
    },
    [configuredRuntimes, updateSettings],
  );

  const addRuntime = useCallback(() => {
    const id = newRuntimeId.trim();
    if (!isValidRuntimeId(id) || configuredRuntimes[id as CloudRuntimeId]) {
      return;
    }
    const runtimeId = CloudRuntimeId.make(id);
    updateSettings({
      cloudRuntimeInstances: {
        [runtimeId]: {
          kind: "e2b",
          enabled: true,
          setupCommands: [],
        },
      },
    });
    setNewRuntimeId("");
    void refresh();
  }, [configuredRuntimes, newRuntimeId, refresh, updateSettings]);

  const removeRuntime = useCallback(
    (runtime: CloudRuntimeInstance) => {
      setBusyId(runtime.id);
      void (async () => {
        try {
          // Clear first so a reconnecting client cannot observe a removed
          // runtime with a still-live credential. The server also removes
          // stale credentials transactionally when settings are patched.
          await clearCredential({ environmentId, input: { runtimeId: runtime.id } });
        } catch {
          // Continue removing the configuration; the server-side settings
          // transaction is the authoritative credential cleanup path.
        } finally {
          updateSettings({ cloudRuntimeInstances: { [runtime.id]: null } });
          setApiKeys((current) => {
            const copy = { ...current };
            delete copy[runtime.id];
            return copy;
          });
          setBusyId(null);
          void refresh();
        }
      })();
    },
    [clearCredential, configuredRuntimes, environmentId, refresh, updateSettings],
  );

  const runCredentialCommand = useCallback(
    async (runtimeId: CloudRuntimeId, command: "set" | "clear" | "test") => {
      setBusyId(runtimeId);
      try {
        const result =
          command === "set"
            ? await setCredential({
                environmentId,
                input: { runtimeId, apiKey: apiKeys[runtimeId]?.trim() ?? "" },
              })
            : command === "clear"
              ? await clearCredential({ environmentId, input: { runtimeId } })
              : await testRuntime({ environmentId, input: { runtimeId } });
        if (result._tag === "Success") {
          setRuntimes(result.value.runtimes);
          if (command === "set") {
            setApiKeys((current) => ({ ...current, [runtimeId]: "" }));
          }
        }
      } finally {
        setBusyId((current) => (current === runtimeId ? null : current));
      }
    },
    [apiKeys, clearCredential, environmentId, setCredential, testRuntime],
  );

  const runSandboxCommand = useCallback(
    async (
      runtime: CloudRuntimeInstance,
      sandboxId: string,
      action: "pause" | "resume" | "stop" | "delete",
    ) => {
      setBusyId(runtime.id);
      try {
        const result = await sandboxAction({
          environmentId,
          input: { runtimeId: runtime.id, sandboxId, action },
        });
        if (result._tag === "Success") {
          setRuntimes((current) =>
            current.map((entry) =>
              entry.id === runtime.id ? { ...entry, sandboxes: result.value.sandboxes } : entry,
            ),
          );
        }
      } finally {
        setBusyId((current) => (current === runtime.id ? null : current));
      }
    },
    [environmentId, sandboxAction],
  );

  const refreshSandboxes = useCallback(
    async (runtimeId: CloudRuntimeId) => {
      setBusyId(runtimeId);
      try {
        const result = await listSandboxes({ environmentId, input: { runtimeId } });
        if (result._tag === "Success") {
          setRuntimes((current) =>
            current.map((entry) =>
              entry.id === runtimeId ? { ...entry, sandboxes: result.value.sandboxes } : entry,
            ),
          );
        }
      } finally {
        setBusyId((current) => (current === runtimeId ? null : current));
      }
    },
    [environmentId, listSandboxes],
  );

  const createRuntimeSandbox = useCallback(
    async (runtimeId: CloudRuntimeId) => {
      setBusyId(runtimeId);
      try {
        const result = await createSandbox({
          environmentId,
          input: { runtimeId, name: `t3-${runtimeId}` },
        });
        if (result._tag === "Success") {
          setRuntimes((current) =>
            current.map((entry) =>
              entry.id === runtimeId ? { ...entry, sandboxes: result.value.sandboxes } : entry,
            ),
          );
        }
      } finally {
        setBusyId((current) => (current === runtimeId ? null : current));
      }
    },
    [createSandbox, environmentId],
  );

  const visibleRuntimes = useMemo(
    () =>
      Object.entries(configuredRuntimes).map(([runtimeId, config]) => {
        const listed = runtimes.find((runtime) => runtime.id === runtimeId);
        if (listed) {
          const connectionChanged =
            runtimeConnectionFingerprint(listed.config) !== runtimeConnectionFingerprint(config);
          return {
            ...listed,
            config,
            ...(connectionChanged
              ? {
                  sandboxes: [],
                  health: {
                    status: config.enabled ? "checking" : "disabled",
                    message: config.enabled ? "Checking runtime…" : "Cloud runtime is disabled.",
                    checkedAt: new Date().toISOString(),
                  },
                }
              : {}),
          } satisfies CloudRuntimeInstance;
        }
        return {
          id: CloudRuntimeId.make(runtimeId),
          config,
          hasCredential: false,
          health: {
            status: config.enabled ? "checking" : "disabled",
            message: config.enabled ? "Checking runtime…" : "Cloud runtime is disabled.",
            checkedAt: new Date().toISOString(),
          },
          sandboxes: [],
        } satisfies CloudRuntimeInstance;
      }),
    [configuredRuntimes, runtimes],
  );

  return (
    <SettingsSection
      id="cloud-runtimes"
      title="Cloud runtimes"
      headerAction={
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Refresh cloud runtimes"
          disabled={readOnly || busyId !== null}
          onClick={() => void refresh()}
        >
          <RefreshCwIcon className={busyId !== null ? "animate-spin" : undefined} />
        </Button>
      }
    >
      <SettingsGroup divided={false} className="overflow-hidden">
        <SettingsRow
          title="Remote execution targets"
          description="Run Codex, Claude Code, and other compatible agents in an isolated cloud sandbox. Credentials are stored by the environment, never in settings."
        />
        {visibleRuntimes.map((runtime) => {
          const config = configuredRuntimes[runtime.id];
          if (!config) return null;
          const isBusy = busyId === runtime.id;
          return (
            <div key={runtime.id} className="border-t border-border/50 p-3 sm:p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-medium">{runtimeLabel(runtime)}</h3>
                  <p className="truncate font-mono text-xs text-muted-foreground">{runtime.id}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{healthLabel(runtime)}</span>
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Remove ${runtimeLabel(runtime)}`}
                    disabled={readOnly || isBusy}
                    onClick={() => removeRuntime(runtime)}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              </div>
              <div className="space-y-1">
                <SettingsRow
                  title="Vendor"
                  control={
                    <Select
                      value={config.kind}
                      onValueChange={(value) => {
                        if (value) updateRuntime(runtime.id, { kind: value as CloudRuntimeKind });
                      }}
                      disabled={readOnly}
                    >
                      <SelectTrigger size="sm" className="w-36">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        {RUNTIME_KINDS.map((kind) => (
                          <SelectItem key={kind.value} value={kind.value}>
                            {kind.label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  }
                />
                <SettingsRow
                  title="Display name"
                  control={
                    <Input
                      size="sm"
                      value={config.displayName ?? ""}
                      placeholder={runtime.id}
                      disabled={readOnly}
                      onValueChange={(value) => updateRuntime(runtime.id, { displayName: value })}
                    />
                  }
                />
                <SettingsRow
                  title="Enabled"
                  control={
                    <Switch
                      size="sm"
                      checked={config.enabled}
                      disabled={readOnly}
                      onCheckedChange={(checked) => updateRuntime(runtime.id, { enabled: checked })}
                    />
                  }
                />
                <SettingsRow
                  title="Region"
                  description="Optional vendor region, for example us-east-1."
                  control={
                    <Input
                      size="sm"
                      value={config.region ?? ""}
                      placeholder="Default"
                      disabled={readOnly}
                      onValueChange={(value) => updateRuntime(runtime.id, { region: value })}
                    />
                  }
                />
                <SettingsRow
                  title="Domain"
                  description="Optional E2B or Novita API domain."
                  control={
                    <Input
                      size="sm"
                      value={config.domain ?? ""}
                      placeholder="Vendor default"
                      disabled={readOnly}
                      onValueChange={(value) => updateRuntime(runtime.id, { domain: value })}
                    />
                  }
                />
                <SettingsRow
                  title="Template or snapshot"
                  description="Optional sandbox image/template identifier."
                  control={
                    <Input
                      size="sm"
                      value={config.template ?? ""}
                      placeholder="Vendor default"
                      disabled={readOnly}
                      onValueChange={(value) => updateRuntime(runtime.id, { template: value })}
                    />
                  }
                />
                <SettingsRow
                  title="API endpoint"
                  description="Optional custom Daytona API endpoint."
                  control={
                    <Input
                      size="sm"
                      value={apiUrlDrafts[runtime.id] ?? config.apiUrl ?? ""}
                      placeholder="Vendor default"
                      disabled={readOnly}
                      onValueChange={(value) =>
                        setApiUrlDrafts((current) => ({ ...current, [runtime.id]: value }))
                      }
                      onBlur={() => {
                        const value = apiUrlDrafts[runtime.id] ?? config.apiUrl ?? "";
                        if (!isValidCloudApiUrl(value)) return;
                        updateRuntime(runtime.id, { apiUrl: value });
                        setApiUrlDrafts((current) => {
                          const next = { ...current };
                          delete next[runtime.id];
                          return next;
                        });
                      }}
                    />
                  }
                />
                <SettingsRow
                  title="Auto-pause minutes"
                  description="Automatically pause idle Daytona sandboxes. Leave blank for the vendor default."
                  control={
                    <Input
                      size="sm"
                      type="number"
                      min={0}
                      value={
                        config.autoPauseMinutes === undefined ? "" : String(config.autoPauseMinutes)
                      }
                      placeholder="Vendor default"
                      disabled={readOnly}
                      onValueChange={(value) =>
                        updateRuntime(runtime.id, {
                          autoPauseMinutes:
                            value.trim() === ""
                              ? null
                              : Number.isFinite(Number(value))
                                ? Math.max(0, Math.floor(Number(value)))
                                : null,
                        })
                      }
                    />
                  }
                />
                <SettingsRow
                  title="Setup commands"
                  description="One command per line. They run when a new sandbox is prepared."
                  control={
                    <Textarea
                      value={config.setupCommands.join("\n")}
                      placeholder="npm install -g @openai/codex"
                      rows={3}
                      disabled={readOnly}
                      onChange={(event) =>
                        updateRuntime(runtime.id, {
                          setupCommands: event.currentTarget.value
                            .split(/\r?\n/u)
                            .filter((line) => line.trim().length > 0),
                        })
                      }
                    />
                  }
                />
                <SettingsRow
                  title="API key"
                  description={
                    runtime.hasCredential
                      ? "A credential is stored. Enter a new value only to replace it."
                      : "Required before this runtime can be tested or used."
                  }
                  control={
                    <div className="flex min-w-0 items-center gap-2">
                      <Input
                        size="sm"
                        type="password"
                        autoComplete="new-password"
                        value={apiKeys[runtime.id] ?? ""}
                        placeholder={runtime.hasCredential ? "••••••••" : "Enter API key"}
                        disabled={readOnly}
                        onValueChange={(value) =>
                          setApiKeys((current) => ({ ...current, [runtime.id]: value }))
                        }
                      />
                      <Button
                        size="xs"
                        disabled={readOnly || isBusy || !apiKeys[runtime.id]?.trim()}
                        onClick={() => void runCredentialCommand(runtime.id, "set")}
                      >
                        Save
                      </Button>
                      {runtime.hasCredential ? (
                        <Button
                          size="xs"
                          variant="ghost-muted"
                          disabled={readOnly || isBusy}
                          onClick={() => void runCredentialCommand(runtime.id, "clear")}
                        >
                          Clear
                        </Button>
                      ) : null}
                    </div>
                  }
                />
                <SettingsRow
                  title="Actions"
                  description="Test the connection or prepare a sandbox for a new remote agent session."
                  control={
                    <div className="flex items-center gap-2">
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        disabled={readOnly || isBusy || !config.enabled || !runtime.hasCredential}
                        onClick={() => void runCredentialCommand(runtime.id, "test")}
                      >
                        Test
                      </Button>
                      <Button
                        size="xs"
                        disabled={readOnly || isBusy || !config.enabled || !runtime.hasCredential}
                        onClick={() => void createRuntimeSandbox(runtime.id)}
                      >
                        Create sandbox
                      </Button>
                    </div>
                  }
                />
                {runtime.sandboxes.length > 0 ? (
                  <SettingsRow
                    title="Sandboxes"
                    description="Pause, resume, stop, or remove a remote sandbox."
                    control={
                      <div className="w-full space-y-2">
                        {runtime.sandboxes.map((sandbox) => (
                          <div
                            key={sandbox.sandboxId}
                            className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 px-2 py-1.5"
                          >
                            <div className="min-w-0">
                              <p className="truncate font-mono text-xs">{sandbox.sandboxId}</p>
                              <p className="text-xs text-muted-foreground">{sandbox.state}</p>
                            </div>
                            <div className="flex items-center gap-1">
                              {sandbox.state === "running" ? (
                                <Button
                                  size="xs"
                                  variant="ghost-muted"
                                  disabled={readOnly || isBusy}
                                  onClick={() =>
                                    void runSandboxCommand(runtime, sandbox.sandboxId, "pause")
                                  }
                                >
                                  Pause
                                </Button>
                              ) : null}
                              {sandbox.state === "paused" ? (
                                <Button
                                  size="xs"
                                  variant="ghost-muted"
                                  disabled={readOnly || isBusy}
                                  onClick={() =>
                                    void runSandboxCommand(runtime, sandbox.sandboxId, "resume")
                                  }
                                >
                                  Resume
                                </Button>
                              ) : null}
                              {sandbox.state !== "stopped" && sandbox.state !== "error" ? (
                                <Button
                                  size="xs"
                                  variant="ghost-muted"
                                  disabled={readOnly || isBusy}
                                  onClick={() =>
                                    void runSandboxCommand(runtime, sandbox.sandboxId, "stop")
                                  }
                                >
                                  Stop
                                </Button>
                              ) : null}
                              <Button
                                size="xs"
                                variant="ghost-destructive"
                                disabled={readOnly || isBusy}
                                onClick={() =>
                                  void runSandboxCommand(runtime, sandbox.sandboxId, "delete")
                                }
                              >
                                Delete
                              </Button>
                            </div>
                          </div>
                        ))}
                        <Button
                          size="xs"
                          variant="ghost-muted"
                          disabled={readOnly || isBusy}
                          onClick={() => void refreshSandboxes(runtime.id)}
                        >
                          Refresh sandboxes
                        </Button>
                      </div>
                    }
                  />
                ) : null}
              </div>
            </div>
          );
        })}
        <SettingsRow
          title="Add runtime"
          description="Use a stable lowercase or uppercase identifier, for example team-e2b."
          control={
            <div className="flex items-center gap-2">
              <Input
                size="sm"
                value={newRuntimeId}
                placeholder="runtime-id"
                disabled={readOnly}
                onValueChange={setNewRuntimeId}
              />
              <Button
                size="xs"
                disabled={
                  readOnly ||
                  !isValidRuntimeId(newRuntimeId.trim()) ||
                  configuredRuntimes[newRuntimeId.trim() as CloudRuntimeId] !== undefined
                }
                onClick={addRuntime}
              >
                <PlusIcon />
                Add
              </Button>
            </div>
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
