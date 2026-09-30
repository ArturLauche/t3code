"use client";

import { ChevronRightIcon, LockIcon, PencilIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  OpenCodeProviderModelSetting,
  OpenCodeProviderSettingsMap,
  ServerProviderModel,
} from "@t3tools/contracts";
import {
  type OpenCodeProviderEntry,
  openCodeProviderEntries,
} from "@t3tools/shared/openCodeProviderConfig";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow } from "./settingsLayout";
import {
  type DiscoveredOpenCodeProvider,
  describeOpenCodeModel,
  discoverOpenCodeProviders,
  findOpenCodeProviderEntry,
  isModelReportedByOpenCode,
  newOpenCodeModelEntry,
  newOpenCodeProviderEntry,
  openCodeProviderIssues,
  upsertOpenCodeProvider,
  withOpenCodeProviderModel,
  withoutOpenCodeProvider,
  withoutOpenCodeProviderModel,
} from "./openCodeProviders.logic";

/** Rows above this many providers get a filter box; below it they all fit. */
const FILTER_THRESHOLD = 8;

function GroupLabel({ children }: { readonly children: string }) {
  return <div className="px-3 pt-3 pb-1 text-2xs text-muted-foreground sm:px-4">{children}</div>;
}

/**
 * Connection settings for one provider. Edits commit as they are made, the
 * same way the environment variables above do, so a half-typed key lands in
 * the environment and the marker in settings rather than being held in a
 * draft the user might never save.
 */
function OpenCodeProviderFields({
  entry,
  isNew,
  npmIssue,
  onChange,
  error,
}: {
  readonly entry: OpenCodeProviderEntry;
  readonly isNew: boolean;
  /** Message for the package field, when that is what needs attention. */
  readonly npmIssue: string | null;
  readonly onChange: (next: OpenCodeProviderEntry) => void;
  readonly error: string | null;
}) {
  // A new provider usually needs a package, so its advanced fields start open;
  // an existing one keeps them behind a disclosure.
  const [showAdvanced, setShowAdvanced] = useState(isNew);
  const envValue = entry.env.join(", ");

  return (
    <div className="flex flex-col gap-1 px-3 pb-3 sm:px-4">
      <SettingsRow
        title="Display name"
        description="Optional. OpenCode shows this instead of the provider id."
        control={
          <Input
            size="sm"
            className="@min-[32rem]/settings-row:w-64"
            value={entry.name ?? ""}
            onChange={(event) => onChange({ ...entry, name: event.target.value })}
            placeholder={entry.providerId}
            aria-label="Provider display name"
            spellCheck={false}
          />
        }
      />
      <SettingsRow
        title="Base URL"
        description="Optional. Point this provider at a relay or self-hosted endpoint."
        control={
          <Input
            size="sm"
            font="mono"
            className="@min-[32rem]/settings-row:w-64"
            value={entry.baseUrl ?? ""}
            onChange={(event) => onChange({ ...entry, baseUrl: event.target.value })}
            placeholder="https://api.example.com/v1"
            aria-label="Provider base URL"
            spellCheck={false}
          />
        }
      />
      <SettingsRow
        title="API key"
        description="Stored separately from settings and never sent back to the app."
        status={
          entry.apiKeyRedacted ? (
            <span className="inline-flex items-center gap-1.5">
              <LockIcon className="size-3" aria-hidden />
              A key is stored for this provider.
            </span>
          ) : null
        }
        control={
          <>
            <Input
              size="sm"
              type="password"
              autoComplete="off"
              className="@min-[32rem]/settings-row:w-56"
              value={entry.apiKeyRedacted ? "" : entry.apiKey}
              onChange={(event) =>
                onChange({
                  ...entry,
                  apiKey: event.target.value,
                  apiKeyRedacted: false,
                })
              }
              placeholder={
                entry.apiKeyRedacted ? "Stored, enter a new value to replace" : "No key stored"
              }
              aria-label="Provider API key"
              spellCheck={false}
            />
            {entry.apiKeyRedacted ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-micro"
                      variant="ghost-muted"
                      aria-label="Remove stored API key"
                      onClick={() => onChange({ ...entry, apiKey: "", apiKeyRedacted: false })}
                    />
                  }
                >
                  <XIcon className="size-3" />
                </TooltipTrigger>
                <TooltipPopup side="top">Remove stored key</TooltipPopup>
              </Tooltip>
            ) : null}
          </>
        }
      />
      {!isNew || showAdvanced ? (
        <SettingsRow
          title="Advanced"
          description="Package OpenCode loads for this provider, and environment variables it may read a key from."
          control={
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              onClick={() => setShowAdvanced((current) => !current)}
            >
              <ChevronRightIcon
                className={cn("size-3 transition-transform", showAdvanced && "rotate-90")}
              />
              {showAdvanced ? "Hide" : "Show"}
            </Button>
          }
        />
      ) : null}
      {!showAdvanced ? null : (
        <>
          <SettingsRow
            title="Package"
            description={
              npmIssue ??
              "Optional. OpenCode loads its own SDK for a provider it already knows; set this for anything else."
            }
            control={
              <Input
                size="sm"
                font="mono"
                className="@min-[32rem]/settings-row:w-64"
                value={entry.npm ?? ""}
                onChange={(event) => onChange({ ...entry, npm: event.target.value })}
                placeholder="@ai-sdk/openai-compatible"
                aria-label="Provider package"
                spellCheck={false}
              />
            }
          />
          <SettingsRow
            title="Key environment variables"
            description="Comma separated. OpenCode reads the key from these before using the stored one."
            control={
              <Input
                size="sm"
                font="mono"
                className="@min-[32rem]/settings-row:w-64"
                value={envValue}
                onChange={(event) =>
                  onChange({
                    ...entry,
                    env: event.target.value
                      .split(",")
                      .map((value) => value.trim())
                      .filter((value) => value.length > 0),
                  })
                }
                placeholder="MY_PROVIDER_API_KEY"
                aria-label="Provider key environment variables"
                spellCheck={false}
              />
            }
          />
        </>
      )}
      {error ? <p className="pt-1 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/**
 * OpenCode treats `limit` as one value: setting only half of it makes it reject
 * the whole document, so the pair is edited together.
 */
function setModelTokenLimit(
  model: OpenCodeProviderModelSetting,
  field: "contextLimit" | "outputLimit",
  rawValue: string,
): OpenCodeProviderModelSetting {
  const { contextLimit: _context, outputLimit: _output, ...rest } = model;
  const raw = rawValue.trim();
  if (raw.length === 0) return rest;
  return {
    ...rest,
    [field]: Math.max(field === "contextLimit" ? 0 : 1, Math.round(Number(raw) || 0)),
  };
}

/** Inline editor for one model row inside a configured provider. */
function OpenCodeModelFields({
  draft,
  reported,
  isNew,
  onChange,
  onCancel,
  onSave,
  error,
}: {
  readonly draft: OpenCodeProviderModelSetting;
  readonly reported: boolean;
  readonly isNew: boolean;
  readonly onChange: (next: OpenCodeProviderModelSetting) => void;
  readonly onCancel: () => void;
  readonly onSave: () => void;
  readonly error: string | null;
}) {
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-3"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-2xs text-muted-foreground">Model id</span>
          <Input
            size="sm"
            font="mono"
            autoFocus
            className="min-w-0"
            value={draft.modelId}
            onChange={(event) => onChange({ ...draft, modelId: event.target.value })}
            placeholder="gpt-5.4 or vendor/model"
            aria-label="Model id"
            spellCheck={false}
          />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-2xs text-muted-foreground">Display name</span>
          <Input
            size="sm"
            className="min-w-0"
            value={draft.name ?? ""}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            placeholder={draft.modelId || "Optional"}
            aria-label="Model display name"
            spellCheck={false}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            size="sm"
            checked={draft.reasoning === true}
            onCheckedChange={(checked) => onChange({ ...draft, reasoning: Boolean(checked) })}
            aria-label="Model supports reasoning"
          />
          Reasoning
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            size="sm"
            checked={draft.attachment === true}
            onCheckedChange={(checked) => onChange({ ...draft, attachment: Boolean(checked) })}
            aria-label="Model accepts image attachments"
          />
          Images
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            size="sm"
            checked={draft.toolCall === true}
            onCheckedChange={(checked) => onChange({ ...draft, toolCall: Boolean(checked) })}
            aria-label="Model supports tool calls"
          />
          Tools
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="shrink-0">Context</span>
          <Input
            size="compact"
            font="mono"
            className="w-24"
            type="number"
            min={0}
            step={1000}
            value={draft.contextLimit ?? ""}
            onChange={(event) =>
              onChange(setModelTokenLimit(draft, "contextLimit", event.target.value))
            }
            placeholder="Optional"
            aria-label="Model context window"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="shrink-0">Max output</span>
          <Input
            size="compact"
            font="mono"
            className="w-24"
            type="number"
            min={1}
            step={1000}
            value={draft.outputLimit ?? ""}
            onChange={(event) =>
              onChange(setModelTokenLimit(draft, "outputLimit", event.target.value))
            }
            placeholder="Optional"
            aria-label="Model maximum output"
          />
        </label>
      </div>
      <p className="text-2xs text-muted-foreground">
        OpenCode needs both token limits together. Leave them blank unless the provider documents
        them.
      </p>
      {!isNew && reported ? (
        <p className="text-2xs text-muted-foreground">
          OpenCode already reports this model. Saving changes only what T3 Code and OpenCode show
          for it.
        </p>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={onSave}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

interface OpenCodeProvidersSectionProps {
  /** Models the OpenCode instance reported, i.e. what it connected. */
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly providers: OpenCodeProviderSettingsMap;
  /** True when this instance points at an externally managed OpenCode server. */
  readonly usesExternalServer: boolean;
  readonly onChange: (next: OpenCodeProviderSettingsMap) => void;
}

/**
 * OpenCode provider and model management.
 *
 * Everything here becomes OpenCode's own `provider.<id>` configuration. T3
 * Code does not model or proxy these providers: OpenCode resolves them, and a
 * configured model only reaches the model picker once OpenCode reports it as
 * connected. The list therefore reads in two tiers — what T3 Code manages, and
 * what OpenCode already offers — so the user can tell a saved override from a
 * discovered model.
 */
export function OpenCodeProvidersSection({
  models,
  providers,
  usesExternalServer,
  onChange,
}: OpenCodeProvidersSectionProps) {
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null);
  const [providerDraft, setProviderDraft] = useState<OpenCodeProviderEntry | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState<{
    readonly providerId: string;
    /** Model id of the row being edited, absent when adding a new one. */
    readonly editingModelId?: string;
    readonly model: OpenCodeProviderModelSetting;
  } | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const discovered = useMemo(() => discoverOpenCodeProviders(models), [models]);
  const configuredIds = useMemo(() => new Set(Object.keys(providers)), [providers]);
  const unconfiguredDiscovered = useMemo(
    () => discovered.filter((entry) => !configuredIds.has(entry.providerId)),
    [configuredIds, discovered],
  );
  const validateEntry = openCodeProviderIssues;

  const normalizedFilter = filter.trim().toLowerCase();
  const matchesFilter = (label: string, id: string) =>
    normalizedFilter.length === 0 ||
    label.toLowerCase().includes(normalizedFilter) ||
    id.toLowerCase().includes(normalizedFilter);

  const saveProviderDraft = () => {
    if (!providerDraft) return;
    const issues = validateEntry(providerDraft);
    if (issues.length > 0) {
      setProviderError(issues[0]?.message ?? "Check the provider settings.");
      return;
    }
    onChange(upsertOpenCodeProvider(providers, providerDraft));
    setExpandedProviderId(providerDraft.providerId);
    setProviderDraft(null);
    setProviderError(null);
  };

  // Editing any field must keep which row is being edited, or Save would treat
  // the unchanged id as a colliding addition.
  const updateModelDraft = (model: OpenCodeProviderModelSetting) =>
    setModelDraft((current) => (current === null ? null : { ...current, model }));

  const saveModelDraft = () => {
    if (!modelDraft) return;
    const entry = findOpenCodeProviderEntry(providers, modelDraft.providerId);
    if (!entry) return;
    const modelId = modelDraft.model.modelId.trim();
    if (modelId.length === 0) {
      setModelError("Enter a model id.");
      return;
    }
    // Renaming a model onto another row would silently replace it, so an
    // addition that collides is an error instead.
    if (modelId !== modelDraft.editingModelId && entry.models.some((m) => m.modelId === modelId)) {
      setModelError(`Model “${modelId}” is already listed.`);
      return;
    }
    const next = withOpenCodeProviderModel(entry, { ...modelDraft.model, modelId });
    const issues = validateEntry(next);
    if (issues.length > 0) {
      setModelError(issues[0]?.message ?? "Check the model settings.");
      return;
    }
    onChange(upsertOpenCodeProvider(providers, next));
    setModelDraft(null);
    setModelError(null);
  };

  const removeProvider = (providerId: string) => {
    onChange(withoutOpenCodeProvider(providers, providerId));
    setExpandedProviderId((current) => (current === providerId ? null : current));
  };

  const removeModel = (providerId: string, modelId: string) => {
    const entry = findOpenCodeProviderEntry(providers, providerId);
    if (!entry) return;
    onChange(upsertOpenCodeProvider(providers, withoutOpenCodeProviderModel(entry, modelId)));
  };

  const renderModelRows = (entry: OpenCodeProviderEntry) => {
    const reported = (modelId: string) =>
      isModelReportedByOpenCode({
        providerId: entry.providerId,
        modelId,
        models,
      });
    return (
      <div className="px-3 pb-3 sm:px-4">
        <div className="flex flex-wrap items-center justify-between gap-2 py-1">
          <span className="text-2xs text-muted-foreground">
            {entry.models.length} configured model{entry.models.length === 1 ? "" : "s"}
          </span>
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            onClick={() => {
              setModelDraft({ providerId: entry.providerId, model: newOpenCodeModelEntry("") });
              setModelError(null);
            }}
          >
            <PlusIcon className="size-3" />
            Add model
          </Button>
        </div>
        {entry.models.length === 0 ? (
          <p className="py-1 text-xs text-muted-foreground">
            No models added. OpenCode only offers the models it already knows for this provider.
          </p>
        ) : null}
        {/* The "add" form and the per-row editor are the same component;
            only one of them is ever mounted, or Save appears twice. */}
        {modelDraft !== null && modelDraft.editingModelId === undefined ? (
          <div className="mb-2">
            <OpenCodeModelFields
              draft={modelDraft.model}
              isNew
              reported={reported(modelDraft.model.modelId.trim())}
              error={modelError}
              onChange={(model) => updateModelDraft(model)}
              onCancel={() => {
                setModelDraft(null);
                setModelError(null);
              }}
              onSave={saveModelDraft}
            />
          </div>
        ) : null}
        <div className="flex flex-col gap-0.5">
          {entry.models.map((model) => {
            const labels = describeOpenCodeModel(model);
            const isReported = reported(model.modelId);
            const isEditing =
              modelDraft !== null &&
              modelDraft.providerId === entry.providerId &&
              modelDraft.editingModelId === model.modelId;
            return (
              <div key={model.modelId}>
                <div className="grid h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 transition-colors hover:bg-muted/30">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate text-xs text-foreground/90">
                      {model.name?.trim() || model.modelId}
                    </span>
                    {model.name?.trim() ? (
                      <code className="truncate font-mono text-2xs text-muted-foreground/70">
                        {model.modelId}
                      </code>
                    ) : null}
                    <span className="hidden text-2xs text-muted-foreground/70 sm:inline">
                      {labels.join(" · ")}
                    </span>
                    {isReported ? null : (
                      <span className="text-2xs text-muted-foreground/70">not connected yet</span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-0.5">
                    <Button
                      type="button"
                      size="icon-micro"
                      variant="ghost-muted"
                      aria-label={`Edit model ${model.modelId}`}
                      onClick={() => {
                        setModelDraft({
                          providerId: entry.providerId,
                          editingModelId: model.modelId,
                          model,
                        });
                        setModelError(null);
                      }}
                    >
                      <PencilIcon className="size-3" />
                    </Button>
                    <Button
                      type="button"
                      size="icon-micro"
                      variant="ghost-destructive"
                      aria-label={`Remove model ${model.modelId}`}
                      onClick={() => removeModel(entry.providerId, model.modelId)}
                    >
                      <XIcon className="size-3" />
                    </Button>
                  </span>
                </div>
                {isEditing ? (
                  <div className="my-1">
                    <OpenCodeModelFields
                      draft={modelDraft.model}
                      isNew={false}
                      reported={isReported}
                      error={modelError}
                      onChange={updateModelDraft}
                      onCancel={() => {
                        setModelDraft(null);
                        setModelError(null);
                      }}
                      onSave={saveModelDraft}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const renderConfiguredProvider = (entry: OpenCodeProviderEntry) => {
    const issues = validateEntry(entry);
    const isExpanded = expandedProviderId === entry.providerId;
    return (
      <div key={entry.providerId} className="border-b border-border/50 last:border-b-0">
        <div className="flex min-h-9 items-center gap-2 px-3 sm:px-4">
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            className="min-w-0 flex-1 justify-start"
            aria-expanded={isExpanded}
            onClick={() => setExpandedProviderId(isExpanded ? null : entry.providerId)}
          >
            <ChevronRightIcon
              className={cn("size-3 shrink-0 transition-transform", isExpanded && "rotate-90")}
            />
            <code className="truncate font-mono text-xs text-foreground/90">
              {entry.providerId}
            </code>
            {entry.name?.trim() ? (
              <span className="truncate text-xs text-muted-foreground">{entry.name}</span>
            ) : null}
            {issues.length > 0 ? (
              <Badge variant="warning" size="sm" className="shrink-0">
                Needs attention
              </Badge>
            ) : null}
          </Button>
          <span className="shrink-0 text-2xs text-muted-foreground">
            {entry.models.length} model{entry.models.length === 1 ? "" : "s"}
          </span>
          <Button
            type="button"
            size="icon-micro"
            variant="ghost-destructive"
            aria-label={`Remove provider ${entry.providerId}`}
            onClick={() => removeProvider(entry.providerId)}
          >
            <Trash2Icon className="size-3" />
          </Button>
        </div>
        {isExpanded ? (
          <>
            {issues.length > 0 ? (
              <p className="px-3 pb-1 text-xs text-destructive sm:px-4">{issues[0]?.message}</p>
            ) : null}
            <OpenCodeProviderFields
              entry={entry}
              isNew={false}
              npmIssue={issues.find((issue) => issue.field === "npm")?.message ?? null}
              error={null}
              onChange={(next) => onChange(upsertOpenCodeProvider(providers, next))}
            />
            {renderModelRows(entry)}
          </>
        ) : null}
      </div>
    );
  };

  // Discovered providers are inspectable too: the model ids are what a user
  // needs to decide whether to configure the provider or to add one model.
  const renderDiscoveredProvider = (entry: DiscoveredOpenCodeProvider) => {
    const isExpanded = expandedProviderId === entry.providerId;
    return (
      <div key={entry.providerId} className="border-b border-border/50 last:border-b-0">
        <div className="flex min-h-9 items-center gap-2 px-3 sm:px-4">
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            className="min-w-0 flex-1 justify-start"
            aria-expanded={isExpanded}
            aria-label={`${isExpanded ? "Hide" : "Show"} models for ${entry.name}`}
            onClick={() => setExpandedProviderId(isExpanded ? null : entry.providerId)}
          >
            <ChevronRightIcon
              className={cn("size-3 shrink-0 transition-transform", isExpanded && "rotate-90")}
            />
            <span className="truncate text-xs text-foreground/90">{entry.name}</span>
            <code className="truncate font-mono text-2xs text-muted-foreground/70">
              {entry.providerId}
            </code>
          </Button>
          <span className="shrink-0 text-2xs text-muted-foreground">
            {entry.modelIds.length} model{entry.modelIds.length === 1 ? "" : "s"}
          </span>
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            className="shrink-0"
            onClick={() => {
              onChange(
                upsertOpenCodeProvider(
                  providers,
                  newOpenCodeProviderEntry(entry.providerId, entry.name),
                ),
              );
              setExpandedProviderId(entry.providerId);
            }}
          >
            <PlusIcon className="size-3" />
            Add settings
          </Button>
        </div>
        {isExpanded ? (
          <div className="flex flex-wrap gap-x-3 gap-y-1 px-3 pb-3 pl-8 sm:px-4 sm:pl-8">
            {entry.modelIds.map((modelId) => (
              <code
                key={modelId}
                className="max-w-full truncate font-mono text-2xs text-muted-foreground/80"
              >
                {modelId}
              </code>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  const visibleConfigured = openCodeProviderEntries(providers).filter((entry) =>
    matchesFilter(entry.name ?? entry.providerId, entry.providerId),
  );
  const showFilter =
    Object.keys(providers).length + unconfiguredDiscovered.length > FILTER_THRESHOLD;
  const visibleDiscovered = unconfiguredDiscovered.filter((entry) =>
    matchesFilter(entry.name, entry.providerId),
  );

  return (
    <div data-slot="settings-row" className="@container/settings-row rounded-xl">
      <div className="px-3 py-3 sm:px-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <p className="max-w-xl text-xs leading-normal text-muted-foreground/80">
              Providers and models you add here become OpenCode's own configuration. OpenCode
              connects them, and each model appears in the picker once it does.
            </p>
            {usesExternalServer ? (
              <p className="max-w-xl text-xs leading-normal text-warning">
                This instance uses a configured OpenCode server. T3 Code cannot change how that
                server is configured, so entries here only apply to a server T3 Code starts.
              </p>
            ) : null}
          </div>
          {showFilter ? (
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter providers"
              size="sm"
              className="w-48 max-w-full"
              spellCheck={false}
              aria-label="Filter providers"
            />
          ) : null}
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            className="shrink-0"
            onClick={() => {
              setProviderDraft(newOpenCodeProviderEntry(""));
              setProviderError(null);
            }}
          >
            <PlusIcon className="size-3" />
            Add provider
          </Button>
        </div>
      </div>

      {providerDraft ? (
        <div className="border-t border-border/50 bg-muted/20 px-3 py-3 sm:px-4">
          <label className="flex flex-col gap-1 pb-2">
            <span className="text-2xs text-muted-foreground">Provider id</span>
            <Input
              size="sm"
              font="mono"
              autoFocus
              className="sm:max-w-xs"
              value={providerDraft.providerId}
              onChange={(event) =>
                setProviderDraft({ ...providerDraft, providerId: event.target.value })
              }
              placeholder="my-proxy"
              aria-label="New provider id"
              spellCheck={false}
            />
          </label>
          <OpenCodeProviderFields
            entry={providerDraft}
            isNew
            npmIssue={null}
            error={providerError}
            onChange={(next) => {
              setProviderDraft(next);
              setProviderError(null);
            }}
          />
          <div className="flex gap-2 px-3 pb-3 sm:px-4">
            <Button size="sm" variant="outline" onClick={saveProviderDraft}>
              Add provider
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setProviderDraft(null);
                setProviderError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {visibleConfigured.length > 0 ? <GroupLabel>Configured in T3 Code</GroupLabel> : null}
      {visibleConfigured.map(renderConfiguredProvider)}

      {visibleDiscovered.length > 0 ? <GroupLabel>Available through OpenCode</GroupLabel> : null}
      {visibleDiscovered.map(renderDiscoveredProvider)}

      {Object.keys(providers).length === 0 && unconfiguredDiscovered.length === 0 ? (
        <p className="px-3 pb-3 text-xs text-muted-foreground sm:px-4">
          OpenCode has not reported any connected providers yet. Enable the instance and refresh to
          see what it offers.
        </p>
      ) : null}
    </div>
  );
}
