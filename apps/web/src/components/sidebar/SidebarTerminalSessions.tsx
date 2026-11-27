import {
  AuthTerminalOperateScope,
  DEFAULT_TERMINAL_ID,
  ThreadId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { TerminalSquareIcon, XIcon } from "lucide-react";
import { memo, type ReactNode } from "react";
import * as Schema from "effect/Schema";

import { cn } from "~/lib/utils";
import { requestConfirmDialog } from "../../confirmDialog";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentScope } from "../../state/session";
import { terminalEnvironment } from "../../state/terminal";
import {
  useKnownTerminalSessions,
  useStickyTerminalSessions,
  type StickyTerminalSessionEntry,
} from "../../state/terminalSessions";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";

const EXPANDED_STORAGE_KEY = "t3code:sidebar-terminals-expanded";

function terminalSessionStatusDot(status: string | null): string {
  switch (status) {
    case "running":
    case "starting":
      return "bg-emerald-500";
    case "exited":
    case "error":
      return "bg-muted-foreground/50";
    default:
      return "bg-transparent";
  }
}

const SidebarTerminalSessionRow = memo(function SidebarTerminalSessionRow(props: {
  entry: StickyTerminalSessionEntry;
  projectDisplayName: string | null;
  environmentLabel: string | null;
  isActive: boolean;
  onNavigate: (entry: StickyTerminalSessionEntry) => void;
  onDelete: (entry: StickyTerminalSessionEntry) => void;
}) {
  const { entry } = props;
  const gt = useGT();
  const canOperate = useEnvironmentScope(entry.environmentId, AuthTerminalOperateScope);
  const sessions = useKnownTerminalSessions({
    environmentId: entry.environmentId,
    threadId: ThreadId.make(entry.record.id),
  });
  const summary =
    sessions?.find((session) => session.target.terminalId === DEFAULT_TERMINAL_ID)?.state.summary ??
    null;
  const status = summary?.status ?? null;
  const subtitle = [props.projectDisplayName, props.environmentLabel]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" · ");

  return (
    <li className="list-none py-0.5">
      <div
        role="button"
        tabIndex={0}
        data-sidebar-row={`terminal:${entry.environmentId}:${entry.record.id}`}
        aria-label={entry.record.title}
        aria-current={props.isActive ? "page" : undefined}
        className={cn(
          "group/sidebar-row relative flex w-full cursor-pointer items-center gap-2.5 overflow-hidden rounded-md px-2.5 py-1.5 text-left text-sidebar-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
        )}
        onClick={() => props.onNavigate(entry)}
        onKeyDown={(event) => {
          if ((event.target as HTMLElement).closest("button")) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            props.onNavigate(entry);
          }
        }}
      >
        <TerminalSquareIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground/90">
            {entry.record.title}
          </span>
          {subtitle.length > 0 ? (
            <span className="block truncate text-2xs text-secondary-label">{subtitle}</span>
          ) : null}
        </span>
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", terminalSessionStatusDot(status))}
        />
        {canOperate ? (
          <SharedTooltipTrigger
            render={
              <button
                type="button"
                aria-label={gt("Delete terminal session")}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  props.onDelete(entry);
                }}
                className="pointer-events-none inline-flex cursor-pointer items-center rounded-md bg-transparent px-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100"
              >
                <XIcon className="size-3" />
              </button>
            }
            label={<T>Delete terminal session</T>}
          />
        ) : null}
      </div>
    </li>
  );
});

/**
 * Persisted "sticky" terminal sessions, listed between drafts and threads. Each
 * row opens the session's full-page terminal; deleting it kills its PTY.
 */
export function SidebarTerminalSessions(props: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly projectDisplayNameByKey: ReadonlyMap<string, string>;
  readonly environmentLabelById: ReadonlyMap<string, string>;
  readonly routeSessionKey: string | null;
  readonly onNavigate: (entry: StickyTerminalSessionEntry) => void;
  /** Called after the open session is deleted so the route can leave it. */
  readonly onDeletedActive: () => void;
}): ReactNode {
  const gt = useGT();
  const sessions = useStickyTerminalSessions(props.environmentIds);
  const deleteSession = useAtomCommand(terminalEnvironment.sessionStore.delete, {
    reportFailure: false,
  });
  const [expanded, setExpanded] = useLocalStorage(EXPANDED_STORAGE_KEY, true, Schema.Boolean);

  if (sessions.length === 0) return null;

  const handleDelete = async (entry: StickyTerminalSessionEntry) => {
    const confirmed =
      (await requestConfirmDialog(
        gt('Delete terminal session "{title}"? Its shell and history will be removed.', {
          title: entry.record.title,
        }),
        { initialFocus: "cancel" },
      )) ?? true;
    if (!confirmed) return;
    const result = await deleteSession({
      environmentId: entry.environmentId,
      input: { id: entry.record.id },
    });
    if (
      result._tag === "Success" &&
      props.routeSessionKey === `${entry.environmentId}:${entry.record.id}`
    ) {
      props.onDeletedActive();
    }
  };

  return (
    <>
      <li className="list-none">
        <CollapsibleSectionHeader expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {gt("Terminals", { $context: "sidebar section" })}
        </CollapsibleSectionHeader>
      </li>
      {expanded
        ? sessions.map((entry) => (
            <SidebarTerminalSessionRow
              key={`${entry.environmentId}:${entry.record.id}`}
              entry={entry}
              projectDisplayName={
                props.projectDisplayNameByKey.get(
                  `${entry.environmentId}:${entry.record.projectId}`,
                ) ?? null
              }
              environmentLabel={props.environmentLabelById.get(entry.environmentId) ?? null}
              isActive={props.routeSessionKey === `${entry.environmentId}:${entry.record.id}`}
              onNavigate={props.onNavigate}
              onDelete={(target) => void handleDelete(target)}
            />
          ))
        : null}
      <li aria-hidden className="mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60" />
    </>
  );
}
