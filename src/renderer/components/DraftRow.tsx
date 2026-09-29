import { memo, type ReactNode } from "react";
import { X } from "lucide-react";
import type { DraftThread } from "../../workbench/draft-threads";
import { plainChipText } from "./composer-chip-token";
import { ProjectIcon } from "./ProjectIcon";
import { tooltipProps } from "./ui/Tooltip";

/** The first line typed, else what is attached, else "New thread", as T3 Code's draft rows. */
export function draftTitle(draft: Pick<DraftThread, "preview" | "attachments">): string {
  const text = plainChipText(draft.preview).trim();
  if (text) return text;
  if (draft.attachments > 0) return `${draft.attachments} attachment${draft.attachments === 1 ? "" : "s"}`;
  return "New thread";
}

export interface DraftRowProps {
  draft: DraftThread;
  projectIcon?: string;
  onOpen(draftId: string): void;
  /** Absent, the row has no Discard button. */
  onDiscard?(draftId: string): void;
  /** Replaces the Discard button (a touch list's own actions). */
  actions?: ReactNode;
}

/**
 * A new thread's draft in a thread list: the project line with a quiet grey
 * "draft" where a thread shows its state (the design's), and the draft's first
 * line as its title. Two lines, no branch yet.
 */
export const DraftRow = memo(function DraftRow({ draft, projectIcon, onOpen, onDiscard, actions }: DraftRowProps) {
  const title = draftTitle(draft);
  return (
    <article className={`thread-row thread-draft-row${draft.active ? " active" : ""}`} data-draft-id={draft.draftId}>
      <button
        type="button"
        className="thread-main"
        aria-label={`Open draft ${title}`}
        aria-description={`Unsent draft in ${draft.projectName}`}
        aria-current={draft.active ? "true" : undefined}
        onClick={() => onOpen(draft.draftId)}
      >
        <span className="thread-project-line">
          <ProjectIcon project={{ path: draft.projectPath, name: draft.projectName, workspaceId: draft.workspaceId }} icon={projectIcon} />
          <strong>{draft.projectName}</strong>
          <span className="thread-draft-mark">draft</span>
        </span>
        {/* A touch list's long press would show a tooltip instead of its sheet. */}
        <span className="thread-title" {...(actions ? {} : tooltipProps(title, { when: "truncated", side: "right" }))}>{title}</span>
      </button>
      {actions ?? (onDiscard ? <span className="thread-row-actions">
        <button type="button" className="thread-discard" aria-label={`Discard draft ${title}`} {...tooltipProps("Discard draft")} onClick={() => onDiscard(draft.draftId)}>
          <X size={13} />
        </button>
      </span> : null)}
    </article>
  );
});
