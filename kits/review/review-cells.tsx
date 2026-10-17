import { CircleCheck, CircleX, Clock, GitMerge, GitPullRequestDraft, LoaderCircle, MessageSquareWarning, TriangleAlert } from "lucide-react";
import { tooltipProps } from "tau";
import type { InboxStatus, InboxStatusKind } from "./inbox.js";
import { plural } from "./review-words.js";

/** The cells the inbox and All pull requests share: changes, and the status in a few words. */
export function Changes({ files, added, removed }: { files?: number | undefined; added: number; removed: number }) {
  return (
    <span className="rv-changes">
      {files !== undefined ? <span className="rv-files">{plural(files, "file")}</span> : <span className="rv-files" />}
      <span className="stat-add">+{added}</span>
      <span className="stat-del">−{removed}</span>
    </span>
  );
}

const STATUS_ICONS: Partial<Record<InboxStatusKind, typeof CircleCheck>> = {
  passed: CircleCheck,
  failed: CircleX,
  running: LoaderCircle,
  conflicts: TriangleAlert,
  note: Clock,
  rebase: Clock,
  changes: MessageSquareWarning,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  "request-merged": GitMerge,
  already: GitMerge,
};

/** Icon and a few words; where the cell is narrow only the icon stays and the words are its tooltip. */
export function StatusCell({ status }: { status: InboxStatus }) {
  const Icon = STATUS_ICONS[status.kind];
  return (
    <span className="rv-status" data-tone={status.tone} data-kind={status.kind} {...tooltipProps(status.text)}>
      {Icon ? <Icon size={13} aria-hidden="true" /> : null}
      <span className="rv-status-text">{status.text}</span>
    </span>
  );
}

