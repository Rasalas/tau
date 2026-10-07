import { memo, type ReactNode } from "react";
import { GitBranch, LoaderCircle, Pencil, X } from "lucide-react";
import { MiddleTruncate } from "./ui/MiddleTruncate";
import type { DraftThread } from "../../workbench/draft-threads";
import { plainChipText } from "./composer-chip-token";
import { ProjectIcon } from "./ProjectIcon";
import { tooltipProps } from "./ui/Tooltip";

/** The first line typed, else what is attached, else "New thread". */
export function draftTitle(draft: Pick<DraftThread, "preview" | "attachments">): string {
  const text = plainChipText(draft.preview).trim();
  if (text) return text;
  if (draft.attachments > 0) return `${draft.attachments} attachment${draft.attachments === 1 ? "" : "s"}`;
  return "New thread";
}

export interface DraftRowProps {
  draft: DraftThread;
  projectIcon?: string;
  branch?: string;
  onOpen(draftId: string): void;
  /** Absent, the row has no Discard button. */
  onDiscard?(draftId: string): void;
  /** Replaces the Discard button (a touch list's own actions). */
  actions?: ReactNode;
}

/** A draft's project, status, first line and chosen branch in the thread list. */
export const DraftRow = memo(function DraftRow({ draft, projectIcon, branch, onOpen, onDiscard, actions }: DraftRowProps) {
  const title = draftTitle(draft);
  return (
    <article className={`thread-row thread-draft-row${draft.active ? " active" : ""}`} data-draft-id={draft.draftId}>
      <button
        type="button"
        className="thread-main"
        aria-label={`Open draft ${title}`}
        aria-description={`${draft.submitting ? "Starting thread" : "Unsent draft"} in ${draft.projectName}`}
        aria-current={draft.active ? "true" : undefined}
        onClick={() => onOpen(draft.draftId)}
      >
        <span className="thread-project-line">
          <ProjectIcon project={{ path: draft.projectPath, name: draft.projectName, workspaceId: draft.workspaceId }} icon={projectIcon} />
          <strong>{draft.projectName}</strong>
          <span className="thread-draft-mark" {...tooltipProps(draft.submitting ? "Starting thread" : "Unsent draft")}>
            {draft.submitting ? <LoaderCircle size={12} aria-hidden="true" /> : <Pencil size={12} aria-hidden="true" />}
            {draft.submitting ? "Starting" : "Draft"}
          </span>
        </span>
        {/* A touch list's long press would show a tooltip instead of its sheet. */}
        <span className="thread-title" {...(actions ? {} : tooltipProps(title, { when: "truncated", side: "right" }))}>{title}</span>
        {branch ? <span className="thread-meta-line"><span className="thread-branch"><GitBranch size={11} aria-hidden="true" /><MiddleTruncate value={branch} /></span></span> : null}
      </button>
      {actions ?? (onDiscard && !draft.submitting ? <span className="thread-row-actions">
        <button type="button" className="thread-discard" aria-label={`Discard draft ${title}`} {...tooltipProps("Discard draft")} onClick={() => onDiscard(draft.draftId)}>
          <X size={13} />
        </button>
      </span> : null)}
    </article>
  );
});
