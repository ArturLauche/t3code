import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  DEFAULT_TERMINAL_ID,
  ThreadId,
  type EnvironmentId,
  type TerminalSessionRecord,
} from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { useGT } from "gt-react";
import { PencilIcon, PlayIcon, TerminalSquareIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { useStableCallback } from "../hooks/useStableCallback";
import { requestConfirmDialog } from "../confirmDialog";
import { useAtomCommand } from "../state/use-atom-command";
import { serverEnvironment } from "../state/server";
import { useProject } from "../state/entities";
import { useEnvironmentScope } from "../state/session";
import { terminalEnvironment } from "../state/terminal";
import { useStickyTerminalSession } from "../state/terminalSessions";
import { TerminalViewport } from "./ThreadTerminalDrawer";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { SidebarInset } from "./ui/sidebar";
import { Spinner } from "./ui/spinner";
import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../appearanceFonts";
import { MiddleTruncate } from "./ui/middle-truncate";
import { useNavigate } from "@tanstack/react-router";

function TerminalSessionHeader({
  record,
  environmentId,
  onDeleted,
}: {
  readonly record: TerminalSessionRecord;
  readonly environmentId: EnvironmentId;
  readonly onDeleted: () => void;
}) {
  const gt = useGT();
  const canOperate = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const renameSession = useAtomCommand(terminalEnvironment.sessionStore.rename, {
    reportFailure: false,
  });
  const deleteSession = useAtomCommand(terminalEnvironment.sessionStore.delete, {
    reportFailure: false,
  });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(record.title);
  const selectRenameInput = useStableCallback((element: HTMLInputElement | null) => {
    element?.select();
  });

  const commitRename = useStableCallback(async () => {
    const title = draft.trim();
    setEditing(false);
    if (title.length === 0 || title === record.title) {
      setDraft(record.title);
      return;
    }
    const result = await renameSession({
      environmentId,
      input: { id: record.id, title },
    });
    if (result._tag !== "Success") setDraft(record.title);
  });

  const handleDelete = useStableCallback(async () => {
    const confirmed =
      (await requestConfirmDialog(
        gt('Delete terminal session "{title}"? Its shell and history will be removed.', {
          title: record.title,
        }),
        { initialFocus: "cancel" },
      )) ?? true;
    if (!confirmed) return;
    const result = await deleteSession({ environmentId, input: { id: record.id } });
    if (result._tag === "Success") onDeleted();
  });

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/60 bg-background/80 px-3">
      <TerminalSquareIcon className="size-4 shrink-0 text-muted-foreground" />
      {editing ? (
        <Input
          ref={selectRenameInput}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(event) => {
            if (event.key === "Enter") void commitRename();
            if (event.key === "Escape") {
              setDraft(record.title);
              setEditing(false);
            }
          }}
          className="h-7 w-56"
          maxLength={128}
        />
      ) : (
        <span className="truncate text-sm font-medium">{record.title}</span>
      )}
      <MiddleTruncate value={record.cwd} className="hidden min-w-0 flex-1 sm:block" />
      {canOperate ? (
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Rename terminal session")}
            onClick={() => {
              setDraft(record.title);
              setEditing(true);
            }}
          >
            <PencilIcon className="size-3.5" />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Delete terminal session")}
            onClick={() => void handleDelete()}
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Full-page sticky terminal: a persisted PTY the sidebar lists and the app can reopen. */
export function TerminalSessionView({
  environmentId,
  sessionId,
}: {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const { record, loaded } = useStickyTerminalSession(environmentId, sessionId);
  const canRead = useEnvironmentScope(environmentId, AuthTerminalReadScope);
  const canOperate = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const keybindings = serverConfig?.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS;
  const project = useProject(
    record === null ? null : scopeProjectRef(environmentId, record.projectId),
  );
  const runtimeEnv =
    project === null || record === null
      ? {}
      : projectScriptRuntimeEnv({
          project: { cwd: project.workspaceRoot },
          worktreePath: record.worktreePath,
        });
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const [exited, setExited] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const threadRef = scopeThreadRef(environmentId, ThreadId.make(sessionId));

  const restart = useStableCallback(async () => {
    if (record === null || restarting) return;
    setRestarting(true);
    const result = await openTerminal({
      environmentId,
      input: {
        threadId: record.id,
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: record.cwd,
        worktreePath: record.worktreePath,
        ...(record.providerInstanceId !== undefined
          ? { providerInstanceId: record.providerInstanceId }
          : {}),
        env: runtimeEnv,
      },
    });
    setRestarting(false);
    if (result._tag === "Success") setExited(false);
  });

  if (!canRead) {
    return (
      <SidebarInset className="flex h-dvh items-center justify-center">
        <p className="text-sm text-muted-foreground">
          {gt("This connection cannot read terminals.")}
        </p>
      </SidebarInset>
    );
  }
  if (!loaded) {
    return (
      <SidebarInset className="flex h-dvh items-center justify-center">
        <Spinner className="size-5" />
      </SidebarInset>
    );
  }
  if (record === null) {
    return (
      <SidebarInset className="flex h-dvh flex-col items-center justify-center">
        <p className="text-sm text-muted-foreground">
          {gt("This terminal session no longer exists.")}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => void navigate({ to: "/" })}
        >
          {gt("Back to threads")}
        </Button>
      </SidebarInset>
    );
  }

  return (
    <SidebarInset className="flex h-dvh min-w-0 flex-col">
      <TerminalSessionHeader
        record={record}
        environmentId={environmentId}
        onDeleted={() => void navigate({ to: "/" })}
      />
      <div className="relative min-h-0 flex-1">
        {exited ? (
          <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-3 border-b border-border/60 bg-background/90 px-3 py-2 text-xs text-muted-foreground">
            <span>{gt("The shell in this terminal has exited.")}</span>
            {canOperate ? (
              <Button size="xs" variant="outline" disabled={restarting} onClick={restart}>
                <PlayIcon className="size-3" />
                {gt("Restart")}
              </Button>
            ) : null}
          </div>
        ) : null}
        <TerminalViewport
          key={`${record.id}:${record.cwd}`}
          threadRef={threadRef}
          threadId={ThreadId.make(record.id)}
          terminalId={DEFAULT_TERMINAL_ID}
          terminalLabel={record.title}
          cwd={record.cwd}
          worktreePath={record.worktreePath}
          runtimeEnv={runtimeEnv}
          {...(record.providerInstanceId !== undefined
            ? { providerInstanceId: record.providerInstanceId }
            : {})}
          advancedTypography={advancedTypography}
          onSessionExited={() => setExited(true)}
          autoFocus
          visible
          keybindings={keybindings}
        />
      </div>
    </SidebarInset>
  );
}
