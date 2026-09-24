import {
  CloudRuntimeId,
  type CloudRuntimeConfig,
  type CloudRuntimeInstance,
  type CloudRuntimeKind,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Switch, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { AppText as Text } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  resolveMobileSettingsTargets,
  type ScopedMobileSettingsTarget,
} from "./settings-scoped-server";

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

type ConfigPatch = Partial<{
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

function applyPatch(config: CloudRuntimeConfig, patch: ConfigPatch): CloudRuntimeConfig {
  const next = { ...config, ...patch } as CloudRuntimeConfig & {
    displayName?: string;
    region?: string;
    template?: string;
    domain?: string;
    apiUrl?: string;
    autoPauseMinutes?: number;
  };
  if (patch.displayName !== undefined) {
    const value = optionalText(patch.displayName);
    if (value === undefined) delete next.displayName;
    else next.displayName = value;
  }
  for (const key of ["region", "template", "domain", "apiUrl"] as const) {
    if (patch[key] === undefined) continue;
    const value = optionalText(patch[key] ?? "");
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  if (patch.autoPauseMinutes !== undefined) {
    if (patch.autoPauseMinutes === null) delete next.autoPauseMinutes;
    else next.autoPauseMinutes = patch.autoPauseMinutes;
  }
  return next;
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

function healthText(runtime: CloudRuntimeInstance): string {
  if (runtime.health.message) return runtime.health.message;
  switch (runtime.health.status) {
    case "ready":
      return "Ready";
    case "unconfigured":
      return "Add an API key";
    case "disabled":
      return "Disabled";
    case "error":
      return "Connection error";
    default:
      return "Checking…";
  }
}

export function SettingsEnvironmentCloudRuntimesRouteScreen() {
  const insets = useSafeAreaInsets();
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const targets = resolveMobileSettingsTargets(
    selectedTargets,
    selectedProjectKey === null
      ? null
      : (selectedProject?.members.map((member) => member.project) ?? []),
  );
  const environmentTargets = [
    ...new Map(targets.map((target) => [target.environment.environmentId, target])).values(),
  ];
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Cloud runtimes" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          {environmentTargets.length === 0 ? (
            <Text className="px-2 text-base text-foreground-muted">
              Select a connected environment.
            </Text>
          ) : (
            environmentTargets.map((target) => (
              <View key={target.environment.environmentId} className="gap-2">
                <Text className="px-1 text-sm font-semibold text-foreground">
                  {target.environment.label}
                </Text>
                <CloudRuntimeSettings target={target} />
              </View>
            ))
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

function CloudRuntimeSettings({ target }: { readonly target: ScopedMobileSettingsTarget }) {
  const environmentId = target.environment.environmentId;
  const settings = target.settings;
  const [runtimes, setRuntimes] = useState<ReadonlyArray<CloudRuntimeInstance>>([]);
  const [apiKeys, setApiKeys] = useState<Readonly<Record<string, string>>>({});
  const [apiUrlDrafts, setApiUrlDrafts] = useState<Readonly<Record<string, string>>>({});
  const [newRuntimeId, setNewRuntimeId] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const refreshGeneration = useRef(0);

  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "cloud runtime settings update",
    reportFailure: true,
  });
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

  const refreshRuntimes = useCallback(
    async (isCancelled?: () => boolean) => {
      const generation = refreshGeneration.current + 1;
      refreshGeneration.current = generation;
      const result = await listRuntimes({ environmentId, input: {} });
      if (
        generation === refreshGeneration.current &&
        isCancelled?.() !== true &&
        result._tag === "Success"
      ) {
        setRuntimes(result.value.runtimes);
      }
    },
    [environmentId, listRuntimes],
  );

  useEffect(() => {
    // Runtime ids are only unique within an environment. Never carry a key
    // or health snapshot from the previously selected environment.
    refreshGeneration.current += 1;
    setRuntimes([]);
    setApiKeys({});
    setApiUrlDrafts({});
    setBusyId(null);
  }, [environmentId]);

  useEffect(() => {
    if (environmentId === undefined) return;
    let cancelled = false;
    void refreshRuntimes(() => cancelled).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [environmentId, refreshRuntimes]);

  const configuredRuntimes = settings?.cloudRuntimeInstances ?? {};
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
                    message: config.enabled ? "Checking…" : "Disabled",
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
            message: config.enabled ? "Checking…" : "Disabled",
            checkedAt: new Date().toISOString(),
          },
          sandboxes: [],
        } satisfies CloudRuntimeInstance;
      }),
    [configuredRuntimes, runtimes],
  );

  const updateRuntime = (id: CloudRuntimeId, patch: ConfigPatch) => {
    const current = configuredRuntimes[id];
    if (!current) return;
    void updateSettings({
      environmentId,
      input: {
        patch: {
          cloudRuntimeInstances: {
            [id]: applyPatch(current, patch),
          },
        },
      },
    });
  };

  const addRuntime = () => {
    const value = newRuntimeId.trim();
    if (!isValidRuntimeId(value) || configuredRuntimes[value as CloudRuntimeId]) return;
    const id = CloudRuntimeId.make(value);
    void updateSettings({
      environmentId,
      input: {
        patch: {
          cloudRuntimeInstances: {
            [id]: { kind: "e2b", enabled: true, setupCommands: [] },
          },
        },
      },
    })
      .then((result) => {
        if (result._tag === "Success") {
          setNewRuntimeId("");
          return refreshRuntimes();
        }
        return undefined;
      })
      .catch(() => undefined);
  };

  const removeRuntime = (id: CloudRuntimeId) => {
    setBusyId(id);
    void (async () => {
      try {
        await clearCredential({ environmentId, input: { runtimeId: id } });
      } catch {
        // The settings update below also removes stale credentials server-side.
      } finally {
        void updateSettings({
          environmentId,
          input: { patch: { cloudRuntimeInstances: { [id]: null } } },
        });
        setApiKeys((current) => {
          const copy = { ...current };
          delete copy[id];
          return copy;
        });
        setBusyId(null);
      }
    })();
  };

  const run = async (id: CloudRuntimeId, action: () => Promise<unknown>) => {
    setBusyId(id);
    try {
      await action();
    } finally {
      setBusyId((current) => (current === id ? null : current));
    }
  };

  const runSandboxAction = async (
    id: CloudRuntimeId,
    sandboxId: string,
    action: "pause" | "resume" | "stop" | "delete",
  ) => {
    await run(id, async () => {
      const result = await sandboxAction({
        environmentId,
        input: { runtimeId: id, sandboxId, action },
      });
      if (result._tag === "Success") {
        setRuntimes((current) =>
          current.map((entry) =>
            entry.id === id ? { ...entry, sandboxes: result.value.sandboxes } : entry,
          ),
        );
      }
    });
  };

  return (
    <>
      <SettingsSection title="Configured runtimes">
        {visibleRuntimes.length === 0 ? (
          <Text className="p-4 text-base text-foreground-muted">No cloud runtimes configured.</Text>
        ) : (
          visibleRuntimes.map((runtime) => {
            const config = configuredRuntimes[runtime.id];
            if (!config) return null;
            const busy = busyId === runtime.id;
            return (
              <View
                key={runtime.id}
                className="gap-3 border-b border-border/50 p-4 last:border-b-0"
              >
                <View className="flex-row items-center justify-between gap-3">
                  <View className="min-w-0 flex-1">
                    <Text className="truncate text-lg text-foreground">
                      {config.displayName ?? runtime.id}
                    </Text>
                    <Text className="text-sm text-foreground-muted">{healthText(runtime)}</Text>
                  </View>
                  <Switch
                    value={config.enabled}
                    onValueChange={(enabled) => updateRuntime(runtime.id, { enabled })}
                  />
                  <RuntimeButton
                    label="Remove"
                    disabled={busy}
                    onPress={() => removeRuntime(runtime.id)}
                  />
                </View>

                <RuntimeChoice
                  value={config.kind}
                  onChange={(kind) => updateRuntime(runtime.id, { kind })}
                />
                <RuntimeInput
                  label="Display name"
                  value={config.displayName ?? ""}
                  onChangeText={(displayName) => updateRuntime(runtime.id, { displayName })}
                />
                <RuntimeInput
                  label="Region"
                  value={config.region ?? ""}
                  onChangeText={(region) => updateRuntime(runtime.id, { region })}
                />
                <RuntimeInput
                  label="Template or snapshot"
                  value={config.template ?? ""}
                  onChangeText={(template) => updateRuntime(runtime.id, { template })}
                />
                <RuntimeInput
                  label="Domain"
                  value={config.domain ?? ""}
                  onChangeText={(domain) => updateRuntime(runtime.id, { domain })}
                />
                <RuntimeInput
                  label="API endpoint"
                  value={apiUrlDrafts[runtime.id] ?? config.apiUrl ?? ""}
                  onChangeText={(value) =>
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
                <RuntimeInput
                  label="Auto-pause minutes"
                  value={
                    config.autoPauseMinutes === undefined ? "" : String(config.autoPauseMinutes)
                  }
                  keyboardType="number-pad"
                  onChangeText={(value) => {
                    const parsed = Number(value);
                    updateRuntime(runtime.id, {
                      autoPauseMinutes:
                        value.trim() === "" || !Number.isFinite(parsed)
                          ? null
                          : Math.max(0, Math.floor(parsed)),
                    });
                  }}
                />
                <RuntimeInput
                  label="Setup commands (one per line)"
                  value={config.setupCommands.join("\n")}
                  multiline
                  onChangeText={(value) =>
                    updateRuntime(runtime.id, {
                      setupCommands: value.split(/\r?\n/u).filter((line) => line.trim().length > 0),
                    })
                  }
                />
                <RuntimeInput
                  label="API key"
                  value={apiKeys[runtime.id] ?? ""}
                  secureTextEntry
                  placeholder={runtime.hasCredential ? "Stored; enter a replacement" : "Required"}
                  onChangeText={(value) =>
                    setApiKeys((current) => ({ ...current, [runtime.id]: value }))
                  }
                />

                <View className="flex-row flex-wrap gap-2">
                  <RuntimeButton
                    label="Save key"
                    disabled={busy || !apiKeys[runtime.id]?.trim()}
                    onPress={() =>
                      void run(runtime.id, async () => {
                        const result = await setCredential({
                          environmentId,
                          input: {
                            runtimeId: runtime.id,
                            apiKey: apiKeys[runtime.id]?.trim() ?? "",
                          },
                        });
                        if (result._tag === "Success") {
                          setRuntimes(result.value.runtimes);
                          setApiKeys((current) => ({ ...current, [runtime.id]: "" }));
                        }
                      })
                    }
                  />
                  <RuntimeButton
                    label="Test"
                    disabled={busy || !config.enabled || !runtime.hasCredential}
                    onPress={() =>
                      void run(runtime.id, async () => {
                        const result = await testRuntime({
                          environmentId,
                          input: { runtimeId: runtime.id },
                        });
                        if (result._tag === "Success") setRuntimes(result.value.runtimes);
                      })
                    }
                  />
                  <RuntimeButton
                    label="Create sandbox"
                    disabled={busy || !config.enabled || !runtime.hasCredential}
                    onPress={() =>
                      void run(runtime.id, async () => {
                        const result = await createSandbox({
                          environmentId,
                          input: { runtimeId: runtime.id, name: `t3-${runtime.id}` },
                        });
                        if (result._tag === "Success") {
                          setRuntimes((current) =>
                            current.map((entry) =>
                              entry.id === runtime.id
                                ? { ...entry, sandboxes: result.value.sandboxes }
                                : entry,
                            ),
                          );
                        }
                      })
                    }
                  />
                  {runtime.hasCredential ? (
                    <RuntimeButton
                      label="Clear key"
                      disabled={busy}
                      onPress={() =>
                        void run(runtime.id, async () => {
                          const result = await clearCredential({
                            environmentId,
                            input: { runtimeId: runtime.id },
                          });
                          if (result._tag === "Success") setRuntimes(result.value.runtimes);
                        })
                      }
                    />
                  ) : null}
                </View>

                {runtime.sandboxes.map((sandbox) => (
                  <View key={sandbox.sandboxId} className="gap-2 rounded-xl bg-muted/30 p-3">
                    <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                      {sandbox.sandboxId} · {sandbox.state}
                    </Text>
                    <View className="flex-row flex-wrap gap-2">
                      <RuntimeButton
                        label="Refresh"
                        disabled={busy}
                        onPress={() =>
                          void run(runtime.id, async () => {
                            const result = await listSandboxes({
                              environmentId,
                              input: { runtimeId: runtime.id },
                            });
                            if (result._tag === "Success") {
                              setRuntimes((current) =>
                                current.map((entry) =>
                                  entry.id === runtime.id
                                    ? { ...entry, sandboxes: result.value.sandboxes }
                                    : entry,
                                ),
                              );
                            }
                          })
                        }
                      />
                      {sandbox.state === "running" ? (
                        <RuntimeButton
                          label="Pause"
                          disabled={busy}
                          onPress={() =>
                            void runSandboxAction(runtime.id, sandbox.sandboxId, "pause")
                          }
                        />
                      ) : null}
                      {sandbox.state === "paused" ? (
                        <RuntimeButton
                          label="Resume"
                          disabled={busy}
                          onPress={() =>
                            void runSandboxAction(runtime.id, sandbox.sandboxId, "resume")
                          }
                        />
                      ) : null}
                      {sandbox.state !== "stopped" && sandbox.state !== "error" ? (
                        <RuntimeButton
                          label="Stop"
                          disabled={busy}
                          onPress={() =>
                            void runSandboxAction(runtime.id, sandbox.sandboxId, "stop")
                          }
                        />
                      ) : null}
                      <RuntimeButton
                        label="Delete"
                        disabled={busy}
                        onPress={() =>
                          void runSandboxAction(runtime.id, sandbox.sandboxId, "delete")
                        }
                      />
                    </View>
                  </View>
                ))}
              </View>
            );
          })
        )}
      </SettingsSection>

      <SettingsSection title="Add runtime">
        <View className="gap-3 p-4">
          <RuntimeInput
            label="Runtime ID"
            value={newRuntimeId}
            autoCapitalize="none"
            onChangeText={setNewRuntimeId}
          />
          <RuntimeButton
            label="Add runtime"
            disabled={
              !isValidRuntimeId(newRuntimeId.trim()) ||
              configuredRuntimes[newRuntimeId.trim() as CloudRuntimeId] !== undefined
            }
            onPress={addRuntime}
          />
        </View>
      </SettingsSection>
    </>
  );
}

function RuntimeInput(props: {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly onBlur?: () => void;
  readonly secureTextEntry?: boolean;
  readonly multiline?: boolean;
  readonly keyboardType?: "default" | "number-pad";
  readonly autoCapitalize?: "none" | "sentences";
  readonly placeholder?: string;
}) {
  return (
    <View className="gap-1">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <TextInput
        className="rounded-xl border border-border bg-background px-3 py-2 text-base text-foreground"
        value={props.value}
        onChangeText={props.onChangeText}
        onBlur={props.onBlur}
        secureTextEntry={props.secureTextEntry}
        multiline={props.multiline}
        keyboardType={props.keyboardType}
        autoCapitalize={props.autoCapitalize}
        placeholder={props.placeholder}
        placeholderTextColor="hsl(0 0% 50%)"
      />
    </View>
  );
}

function RuntimeChoice(props: {
  readonly value: CloudRuntimeKind;
  readonly onChange: (value: CloudRuntimeKind) => void;
}) {
  return (
    <View className="gap-1">
      <Text className="text-sm text-foreground-muted">Vendor</Text>
      <View className="flex-row flex-wrap gap-2">
        {RUNTIME_KINDS.map((kind) => (
          <RuntimeButton
            key={kind.value}
            label={kind.label}
            selected={props.value === kind.value}
            onPress={() => props.onChange(kind.value)}
          />
        ))}
      </View>
    </View>
  );
}

function RuntimeButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly selected?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className={`rounded-full border px-3 py-2 text-sm ${
        props.selected ? "border-accent bg-accent/10 text-accent" : "border-border text-foreground"
      } ${props.disabled ? "opacity-40" : ""}`}
    >
      <Text className="text-sm">{props.label}</Text>
    </Pressable>
  );
}
