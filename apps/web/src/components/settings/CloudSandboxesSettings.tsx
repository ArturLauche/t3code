import type {
  CloudSandboxCreateInput,
  CloudSandboxLifecycleAction,
  CloudSandboxProviderConnection,
  CloudSandboxProviderKind,
  CloudSandboxRecord,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { CloudIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { connectCloudSandbox } from "../../connection/onboarding";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export const SANDBOX_PROVIDER_LABELS: Record<CloudSandboxProviderKind, string> = {
  daytona: "Daytona",
  e2b: "E2B",
  novita: "Novita AI Agent Sandbox",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The sandbox operation failed.";
}

function resourcesLabel(sandbox: CloudSandboxRecord): string | null {
  const values = [
    sandbox.resources?.cpu ? `${sandbox.resources.cpu} CPU` : null,
    sandbox.resources?.memoryMiB ? `${sandbox.resources.memoryMiB} MiB RAM` : null,
    sandbox.resources?.diskGiB ? `${sandbox.resources.diskGiB} GiB disk` : null,
  ].filter((value): value is string => value !== null);
  return values.length > 0 ? values.join(" · ") : null;
}

function ProviderDialog({ onSaved }: { readonly onSaved: () => Promise<void> }) {
  const bridge = window.desktopBridge;
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<CloudSandboxProviderKind>("daytona");
  const [label, setLabel] = useState("Daytona");
  const [apiKey, setApiKey] = useState("");
  const [apiUrl, setApiUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!bridge || !apiKey.trim() || !label.trim()) return;
    setPending(true);
    setError(null);
    let savedConnection: CloudSandboxProviderConnection | null = null;
    try {
      savedConnection = await bridge.saveCloudSandboxProviderConnection({
        provider,
        label: label.trim(),
        apiKey: apiKey.trim(),
        ...(apiUrl.trim() ? { apiUrl: apiUrl.trim() } : {}),
      });
      await bridge.validateCloudSandboxProviderConnection({ id: savedConnection.id });
      setApiKey("");
      setApiUrl("");
      setOpen(false);
      await onSaved();
      toastManager.add({
        type: "success",
        title: `${SANDBOX_PROVIDER_LABELS[provider]} connected`,
      });
    } catch (cause) {
      if (savedConnection) {
        await bridge
          .removeCloudSandboxProviderConnection({ id: savedConnection.id })
          .catch(() => undefined);
      }
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="xs" variant="ghost" className="h-5 gap-1 px-1 text-[11px]">
            <PlusIcon className="size-3" /> Add sandbox provider
          </Button>
        }
      />
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add sandbox provider</DialogTitle>
          <DialogDescription>
            The API key is encrypted with the operating system secure store and is never added to
            projects or sandbox configuration.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="block space-y-1.5 text-sm">
            <span>Provider</span>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-3"
              value={provider}
              onChange={(event) => {
                const next = event.target.value as CloudSandboxProviderKind;
                setProvider(next);
                setLabel(SANDBOX_PROVIDER_LABELS[next]);
              }}
            >
              {Object.entries(SANDBOX_PROVIDER_LABELS).map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>Connection name</span>
            <Input value={label} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>API key</span>
            <Input
              type="password"
              autoComplete="new-password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="••••••••••••••••"
            />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>API URL (optional)</span>
            <Input value={apiUrl} onChange={(event) => setApiUrl(event.target.value)} />
          </label>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={pending} />}>Cancel</DialogClose>
          <Button disabled={pending || !apiKey.trim() || !label.trim()} onClick={() => void save()}>
            {pending ? (
              <>
                <Spinner className="size-3.5" /> Validating…
              </>
            ) : (
              "Save and validate"
            )}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function CreateSandboxDialog({
  connections,
  onCreated,
}: {
  readonly connections: readonly CloudSandboxProviderConnection[];
  readonly onCreated: () => Promise<void>;
}) {
  const bridge = window.desktopBridge;
  const [open, setOpen] = useState(false);
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("");
  const [image, setImage] = useState("");
  const [region, setRegion] = useState("");
  const [cpu, setCpu] = useState("");
  const [memoryGiB, setMemoryGiB] = useState("");
  const [diskGiB, setDiskGiB] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [timeoutMinutes, setTimeoutMinutes] = useState("60");
  const [timeoutAction, setTimeoutAction] = useState<"stop" | "pause" | "delete">("pause");
  const [autoResume, setAutoResume] = useState(true);
  const [ephemeral, setEphemeral] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected =
    connections.find((connection) => connection.id === connectionId) ?? connections[0];

  useEffect(() => {
    if (!connectionId && connections[0]) setConnectionId(connections[0].id);
  }, [connectionId, connections]);

  const create = async () => {
    if (!bridge || !selected) return;
    const timeout = Number.parseInt(timeoutMinutes, 10);
    const parsedCpu = Number.parseFloat(cpu);
    const parsedMemoryGiB = Number.parseFloat(memoryGiB);
    const parsedDiskGiB = Number.parseFloat(diskGiB);
    const effectiveTimeoutAction = ephemeral ? "delete" : timeoutAction;
    const base = {
      providerConnectionId: selected.id,
      provider: selected.provider,
      ...(name.trim() ? { name: name.trim() } : {}),
      ephemeral,
    } as const;
    const input: CloudSandboxCreateInput =
      selected.provider === "daytona"
        ? {
            ...base,
            provider: "daytona",
            ...(template.trim() ? { snapshot: template.trim() } : {}),
            ...(!template.trim() && image.trim() ? { image: image.trim() } : {}),
            ...(region.trim() ? { region: region.trim() } : {}),
            ...(Number.isFinite(parsedCpu) && parsedCpu > 0 ? { cpu: parsedCpu } : {}),
            ...(Number.isFinite(parsedMemoryGiB) && parsedMemoryGiB > 0
              ? { memoryGiB: parsedMemoryGiB }
              : {}),
            ...(Number.isFinite(parsedDiskGiB) && parsedDiskGiB > 0
              ? { diskGiB: parsedDiskGiB }
              : {}),
            ...(Number.isFinite(timeout)
              ? ephemeral
                ? { ttlMinutes: timeout }
                : effectiveTimeoutAction === "stop"
                  ? { autoStopMinutes: timeout }
                  : effectiveTimeoutAction === "pause"
                    ? { autoPauseMinutes: timeout }
                    : { autoDeleteMinutes: timeout }
              : {}),
          }
        : selected.provider === "e2b"
          ? {
              ...base,
              provider: "e2b",
              ...(template.trim() ? { template: template.trim() } : {}),
              ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMinutes: timeout } : {}),
              timeoutAction: effectiveTimeoutAction === "delete" ? "delete" : "pause",
              autoResume,
            }
          : {
              ...base,
              provider: "novita",
              ...(template.trim() ? { template: template.trim() } : {}),
              ...(nodeId.trim() ? { nodeId: nodeId.trim() } : {}),
              ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMinutes: timeout } : {}),
              timeoutAction: effectiveTimeoutAction === "delete" ? "delete" : "pause",
              autoResume,
            };
    setPending(true);
    setError(null);
    try {
      await bridge.createCloudSandbox(input);
      setOpen(false);
      setName("");
      await onCreated();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="xs" disabled={connections.length === 0}>
            <PlusIcon /> Create sandbox
          </Button>
        }
      />
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create cloud sandbox</DialogTitle>
          <DialogDescription>
            Create a persistent workspace or an automatically deleted task sandbox.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="block space-y-1.5 text-sm">
            <span>Provider connection</span>
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-3"
              value={selected?.id ?? ""}
              onChange={(event) => setConnectionId(event.target.value)}
            >
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>Name</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="my-project"
            />
          </label>
          <label className="block space-y-1.5 text-sm">
            <span>{selected?.provider === "daytona" ? "Snapshot" : "Template"} (optional)</span>
            <Input value={template} onChange={(event) => setTemplate(event.target.value)} />
          </label>
          {selected?.provider === "daytona" ? (
            <>
              <label className="block space-y-1.5 text-sm">
                <span>OCI image (optional, when not using a snapshot)</span>
                <Input
                  value={image}
                  onChange={(event) => setImage(event.target.value)}
                  placeholder="node:22-bookworm"
                />
              </label>
              <label className="block space-y-1.5 text-sm">
                <span>Region / target (optional)</span>
                <Input value={region} onChange={(event) => setRegion(event.target.value)} />
              </label>
              {image.trim() && !template.trim() ? (
                <div className="grid grid-cols-3 gap-2">
                  <label className="block space-y-1.5 text-sm">
                    <span>CPU</span>
                    <Input
                      type="number"
                      min="0.1"
                      step="0.1"
                      value={cpu}
                      onChange={(event) => setCpu(event.target.value)}
                    />
                  </label>
                  <label className="block space-y-1.5 text-sm">
                    <span>RAM GiB</span>
                    <Input
                      type="number"
                      min="0.1"
                      step="0.1"
                      value={memoryGiB}
                      onChange={(event) => setMemoryGiB(event.target.value)}
                    />
                  </label>
                  <label className="block space-y-1.5 text-sm">
                    <span>Disk GiB</span>
                    <Input
                      type="number"
                      min="0.1"
                      step="0.1"
                      value={diskGiB}
                      onChange={(event) => setDiskGiB(event.target.value)}
                    />
                  </label>
                </div>
              ) : null}
            </>
          ) : null}
          {selected?.provider === "novita" ? (
            <label className="block space-y-1.5 text-sm">
              <span>Node ID (optional)</span>
              <Input value={nodeId} onChange={(event) => setNodeId(event.target.value)} />
            </label>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <label className="block space-y-1.5 text-sm">
              <span>Automatic action</span>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-3"
                value={ephemeral ? "delete" : timeoutAction}
                disabled={ephemeral}
                onChange={(event) =>
                  setTimeoutAction(event.target.value as "stop" | "pause" | "delete")
                }
              >
                {selected?.provider === "daytona" ? <option value="stop">Stop</option> : null}
                <option value="pause">Pause</option>
                <option value="delete">Delete</option>
              </select>
            </label>
            <label className="block space-y-1.5 text-sm">
              <span>After minutes</span>
              <Input
                type="number"
                min={1}
                value={timeoutMinutes}
                onChange={(event) => setTimeoutMinutes(event.target.value)}
              />
            </label>
          </div>
          {selected?.provider !== "daytona" ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={autoResume}
                onChange={(event) => setAutoResume(event.target.checked)}
              />{" "}
              Automatically resume on connect
            </label>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={ephemeral}
              onChange={(event) => {
                setEphemeral(event.target.checked);
                if (event.target.checked) setTimeoutAction("delete");
              }}
            />{" "}
            Ephemeral task sandbox
          </label>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={pending} />}>Cancel</DialogClose>
          <Button disabled={pending || !selected} onClick={() => void create()}>
            {pending ? (
              <>
                <Spinner className="size-3.5" /> Creating…
              </>
            ) : (
              "Create"
            )}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function CloudSandboxesSettingsSection() {
  const bridge = window.desktopBridge;
  const connect = useAtomCommand(connectCloudSandbox, { reportFailure: false });
  const { environments } = useEnvironments();
  const projects = useProjects();
  const { handleNewThread } = useHandleNewThread();
  const [connections, setConnections] = useState<readonly CloudSandboxProviderConnection[]>([]);
  const [sandboxes, setSandboxes] = useState<readonly CloudSandboxRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!bridge) return;
    setLoading(true);
    setError(null);
    try {
      const [connectionResult, sandboxResult] = await Promise.allSettled([
        bridge.listCloudSandboxProviderConnections(),
        bridge.listCloudSandboxes(),
      ]);
      if (connectionResult.status === "fulfilled") {
        setConnections(connectionResult.value);
      }
      if (sandboxResult.status === "fulfilled") {
        setSandboxes(sandboxResult.value);
      }
      const failure = [connectionResult, sandboxResult].find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure) setError(errorMessage(failure.reason));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runLifecycle = async (sandbox: CloudSandboxRecord, action: CloudSandboxLifecycleAction) => {
    if (!bridge) return;
    const key = `${sandbox.providerConnectionId}:${sandbox.sandboxId}:${action}`;
    setPendingKey(key);
    try {
      await bridge.runCloudSandboxLifecycleAction({
        providerConnectionId: sandbox.providerConnectionId,
        sandboxId: sandbox.sandboxId,
        action,
      });
      await refresh();
    } catch (cause) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not ${action} sandbox`,
          description: errorMessage(cause),
        }),
      );
    } finally {
      setPendingKey(null);
    }
  };

  const connectSandbox = async (sandbox: CloudSandboxRecord) => {
    const key = `${sandbox.providerConnectionId}:${sandbox.sandboxId}:connect`;
    setPendingKey(key);
    const result = await connect({
      target: {
        providerConnectionId: sandbox.providerConnectionId,
        provider: sandbox.provider,
        sandboxId: sandbox.sandboxId,
      },
      label: sandbox.name,
    });
    setPendingKey(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not connect sandbox",
          description: errorMessage(failure),
        }),
      );
    } else if (result._tag === "Success") {
      toastManager.add({ type: "success", title: `${sandbox.name} connected` });
      await refresh();
    }
  };

  const openAssociatedProject = async (sandbox: CloudSandboxRecord) => {
    if (!sandbox.associatedProject) return;
    const environment = environments.find((candidate) => {
      const profile = Option.getOrNull(candidate.entry.profile);
      return (
        profile?._tag === "CloudSandboxConnectionProfile" &&
        profile.target.providerConnectionId === sandbox.providerConnectionId &&
        profile.target.sandboxId === sandbox.sandboxId
      );
    });
    const project = environment
      ? projects.find(
          (candidate) =>
            candidate.environmentId === environment.environmentId &&
            candidate.workspaceRoot === sandbox.associatedProject,
        )
      : null;
    if (!environment || !project) {
      toastManager.add({
        type: "info",
        title: "Connect this sandbox before opening its project",
      });
      return;
    }
    await handleNewThread(scopeProjectRef(environment.environmentId, project.id));
  };

  const removeProvider = async (connection: CloudSandboxProviderConnection) => {
    const confirmed = await bridge?.confirm(
      `Remove ${connection.label}? Existing provider sandboxes are not deleted, but T3 Code will forget this encrypted API key and its project associations.`,
    );
    if (!bridge || !confirmed) return;
    try {
      await bridge.removeCloudSandboxProviderConnection({ id: connection.id });
      await refresh();
    } catch (cause) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not remove sandbox provider",
          description: errorMessage(cause),
        }),
      );
    }
  };

  if (!bridge) return null;

  return (
    <SettingsSection
      title="Cloud Sandboxes"
      headerAction={
        <div className="flex items-center gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh sandboxes"
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCwIcon className={loading ? "animate-spin" : ""} />
          </Button>
          <ProviderDialog onSaved={refresh} />
        </div>
      }
    >
      <SettingsRow
        title="Managed execution environments"
        description="Agents, files, terminals, and Git run inside the selected provider sandbox. Provider credentials remain in the desktop secure store."
        control={<CreateSandboxDialog connections={connections} onCreated={refresh} />}
      />
      {connections.map((connection) => (
        <SettingsRow
          key={connection.id}
          title={connection.label}
          description={`${SANDBOX_PROVIDER_LABELS[connection.provider]} · API key ••••••••${connection.lastValidatedAt ? " · validated" : ""}`}
          control={
            <Button size="xs" variant="ghost" onClick={() => void removeProvider(connection)}>
              Remove
            </Button>
          }
        />
      ))}
      {sandboxes.map((sandbox) => {
        const keyPrefix = `${sandbox.providerConnectionId}:${sandbox.sandboxId}`;
        const resourceText = resourcesLabel(sandbox);
        const shutdownText = sandbox.automaticShutdown?.action
          ? `Auto ${sandbox.automaticShutdown.action}${sandbox.automaticShutdown.timeoutMinutes ? ` after ${sandbox.automaticShutdown.timeoutMinutes}m` : ""}`
          : null;
        return (
          <SettingsRow
            key={keyPrefix}
            title={
              <span className="inline-flex items-center gap-2">
                <CloudIcon className="size-4" />
                {sandbox.name}
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">
                  {sandbox.status}
                </span>
              </span>
            }
            description={[
              SANDBOX_PROVIDER_LABELS[sandbox.provider],
              sandbox.region,
              resourceText,
              sandbox.persistent ? "Persistent" : "Ephemeral",
              shutdownText,
              sandbox.associatedProject ? `Project: ${sandbox.associatedProject}` : null,
              `Created ${new Date(sandbox.createdAt).toLocaleString()}`,
            ]
              .filter(Boolean)
              .join(" · ")}
            control={
              <div className="flex flex-wrap justify-end gap-1">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={pendingKey?.startsWith(keyPrefix)}
                  onClick={() => void connectSandbox(sandbox)}
                >
                  Connect
                </Button>
                {sandbox.associatedProject ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pendingKey?.startsWith(keyPrefix)}
                    onClick={() => void openAssociatedProject(sandbox)}
                  >
                    Open Project
                  </Button>
                ) : null}
                {sandbox.status === "running" && sandbox.lifecycle.pause ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pendingKey?.startsWith(keyPrefix)}
                    onClick={() => void runLifecycle(sandbox, "pause")}
                  >
                    Pause
                  </Button>
                ) : null}
                {sandbox.status === "running" && sandbox.lifecycle.stop ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pendingKey?.startsWith(keyPrefix)}
                    onClick={() => void runLifecycle(sandbox, "stop")}
                  >
                    Stop
                  </Button>
                ) : null}
                {sandbox.status === "paused" && sandbox.lifecycle.resume ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pendingKey?.startsWith(keyPrefix)}
                    onClick={() => void runLifecycle(sandbox, "resume")}
                  >
                    Resume
                  </Button>
                ) : null}
                {sandbox.status === "stopped" && sandbox.lifecycle.start ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pendingKey?.startsWith(keyPrefix)}
                    onClick={() => void runLifecycle(sandbox, "start")}
                  >
                    Start
                  </Button>
                ) : null}
                {sandbox.lifecycle.delete ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Delete ${sandbox.name}`}
                    disabled={pendingKey?.startsWith(keyPrefix)}
                    onClick={() =>
                      void bridge
                        .confirm(
                          `Delete sandbox ${sandbox.name}? This permanently removes its filesystem.`,
                        )
                        .then((confirmed) =>
                          confirmed ? runLifecycle(sandbox, "delete") : undefined,
                        )
                    }
                  >
                    <Trash2Icon />
                  </Button>
                ) : null}
              </div>
            }
          />
        );
      })}
      {connections.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">
          Add Daytona, E2B, or Novita to create a cloud execution environment.
        </p>
      ) : null}
      {error ? <p className="px-4 py-2 text-xs text-destructive">{error}</p> : null}
    </SettingsSection>
  );
}
