import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Info, MessageSquare, PanelRightClose, PanelRightOpen, WrapText } from "lucide-react";
import { DiffView, READ_ONLY_REASON, errorMessage, getClientStorage, tooltipProps, type WorkbenchActions } from "tau";
import { currentDiffWordWrap } from "./diff-settings.js";
import { providerInfo, type PendingReviewComment, PullRequestComment, PullRequestDetail, PullRequestFile, PullRequestFiles, PullRequestThread, ReviewCommentChip } from "./protocol.js";
import type { PullRequestCommentInput } from "./pull-request-client.js";
import { hideWhitespace } from "./pull-request-diff.js";
import { orderFiles, threadChip } from "./pull-request-logic.js";
import { ThreadCard } from "./pull-request-parts.js";
import { usePullRequestLines } from "./pull-request-lines.js";
import { ALL_WRITES, type PullRequestWrites } from "./pull-request-writes.js";

const TREE_KEY = "tau.review.pr-file-tree-open";

const STATUS_LETTERS: Record<PullRequestFile["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };

function split(path: string): { name: string; directory: string } {
  const at = path.lastIndexOf("/");
  return at < 0 ? { name: path, directory: "" } : { name: path.slice(at + 1), directory: path.slice(0, at) };
}

/**
 * The request's files, one diff at a time beside the file list: review
 * threads under their lines, a new comment from a line's gutter button, and
 * a viewed mark per file that moves on to the next file still to read.
 */
export function PullRequestCode({ detail, files, filesError, threads, focusPath, actions, load, onViewed, onComment, onSend, ignoreWhitespace, onIgnoreWhitespace, reviewComments, onPend, onRemovePending, onResolve, canEdit, onEdit, writes = ALL_WRITES }: {
  detail: PullRequestDetail;
  files?: PullRequestFiles;
  filesError?: string;
  threads: readonly PullRequestThread[];
  focusPath?: string;
  actions: WorkbenchActions;
  load(fresh: boolean): Promise<void>;
  onViewed(path: string, viewed: boolean): Promise<void>;
  onComment(input: PullRequestCommentInput): Promise<void>;
  onSend(chip: ReviewCommentChip): void;
  /** The Review Kit's "Hide whitespace changes" option, the same one the local review reads. */
  ignoreWhitespace: boolean;
  onIgnoreWhitespace(ignore: boolean): void;
  /** Line comments held for the review. */
  reviewComments: readonly PendingReviewComment[];
  onPend(comment: Omit<PendingReviewComment, "id">): void;
  onRemovePending(id: string): void;
  onResolve(thread: PullRequestThread, resolved: boolean): Promise<void>;
  canEdit(comment: PullRequestComment): boolean;
  onEdit(comment: PullRequestComment, body: string): Promise<void>;
  /** What this device may change; a line comment, a reply or a viewed mark is left out or disabled otherwise. */
  writes?: PullRequestWrites;
}) {
  const [selected, setSelected] = useState<string>();
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const [wrap, setWrap] = useState(currentDiffWordWrap);
  const [treeOpen, setTreeOpen] = useState(() => getClientStorage()?.get(TREE_KEY) !== "false");
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [looseOpen, setLooseOpen] = useState(true);

  useEffect(() => { if (!files && !filesError) void load(false); }, [files, filesError, load]);
  useEffect(() => { if (focusPath) setSelected(focusPath); }, [focusPath]);

  const ordered = useMemo(() => orderFiles(files?.files ?? []), [files]);
  const isViewed = (file: PullRequestFile) => pending.get(file.path) ?? file.viewed === "viewed";
  const current = ordered.find((file) => file.path === selected) ?? ordered.find((file) => !isViewed(file)) ?? ordered[0];
  const diffs = useMemo(() => ignoreWhitespace ? (files?.diffs ?? []).map(hideWhitespace) : files?.diffs ?? [], [files, ignoreWhitespace]);
  const diff = useMemo(() => diffs.find((entry) => entry.path === current?.path), [current?.path, diffs]);
  const threadCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of threads) counts.set(thread.path, (counts.get(thread.path) ?? 0) + 1);
    return counts;
  }, [threads]);
  const viewedCount = ordered.filter(isViewed).length;

  const { slotFor, loose, reply, resolver } = usePullRequestLines({ detail, threads, diffs, reviewComments, writes, onComment, onSend, onPend, onRemovePending, onResolve, canEdit, onEdit });
  const lines = useMemo(() => current ? slotFor(current.path) : undefined, [current, slotFor]);

  const toggleViewed = async (file: PullRequestFile) => {
    const next = !isViewed(file);
    setPending((map) => new Map(map).set(file.path, next));
    if (next && file.path === current?.path) {
      const after = ordered.slice(ordered.indexOf(file) + 1).concat(ordered.slice(0, ordered.indexOf(file)));
      const unviewed = after.find((candidate) => !isViewed(candidate));
      if (unviewed) setSelected(unviewed.path);
    }
    try {
      await onViewed(file.path, next);
    } catch (error) {
      actions.notify(`Could not update viewed files: ${errorMessage(error)}`);
    } finally {
      setPending((map) => { const copy = new Map(map); copy.delete(file.path); return copy; });
    }
  };

  const step = (offset: 1 | -1) => {
    if (!current || ordered.length === 0) return;
    const index = ordered.indexOf(current);
    setSelected(ordered[(index + offset + ordered.length) % ordered.length]!.path);
  };

  const setTree = (open: boolean) => { setTreeOpen(open); getClientStorage()?.set(TREE_KEY, String(open)); };

  if (filesError && !files) {
    return (
      <div className="pr-unavailable" role="alert">
        <strong>Could not load the diff</strong>
        <p>{filesError}</p>
        <button className="mini-button" onClick={() => void load(true)}>Retry</button>
      </div>
    );
  }
  if (!files) return <p className="pr-empty pr-pad" role="status">Loading the diff…</p>;
  if (ordered.length === 0) return <p className="pr-empty pr-pad">This {providerInfo(detail.ref.service).noun} has no file changes.</p>;

  return (
    <div className="pr-code">
      <header className="pr-code-toolbar">
        <span>{ordered.length} {ordered.length === 1 ? "file" : "files"}</span>
        <span className="pr-viewed-count" title={files.viewedOn === "local" ? "GitLab keeps no viewed marks, so these are stored in this Tau only." : undefined}>
          {viewedCount} / {ordered.length} viewed{files.viewedOn === "local" ? <> in Tau <Info size={11} aria-hidden="true" /></> : null}
        </span>
        <span className="spacer" />
        <label className="pr-whitespace" title="Show lines that changed only in whitespace as unchanged">
          <input type="checkbox" checked={ignoreWhitespace} onChange={(event) => onIgnoreWhitespace(event.target.checked)} /> Hide whitespace
        </label>
        <button className={`icon-button compact ${wrap ? "active" : ""}`} aria-pressed={wrap} aria-label={wrap ? "Disable line wrapping" : "Enable line wrapping"} title={wrap ? "Disable line wrapping" : "Enable line wrapping"} onClick={() => setWrap(!wrap)}>
          <WrapText size={14} />
        </button>
        <div className="toggle-group" aria-label="Diff layout">
          <button className={layout === "unified" ? "active" : ""} onClick={() => setLayout("unified")}>Unified</button>
          <button className={layout === "split" ? "active" : ""} onClick={() => setLayout("split")}>Split</button>
        </div>
        <button className={`icon-button pr-tree-toggle ${treeOpen ? "active" : ""}`} aria-label={treeOpen ? "Hide file tree" : "Show file tree"} title={treeOpen ? "Hide file tree" : "Show file tree"} aria-expanded={treeOpen} onClick={() => setTree(!treeOpen)}>
          {treeOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
        </button>
      </header>
      <div className="pr-code-body">
        <main className="pr-code-main">
          {loose.length > 0 ? (
            <section className="pr-loose">
              <button className="pr-group-toggle" aria-expanded={looseOpen} onClick={() => setLooseOpen(!looseOpen)}>
                {looseOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Conversations not on the current diff ({loose.length})
              </button>
              {looseOpen ? loose.map((thread) => (
                <div key={thread.id} className="pr-loose-thread">
                  <small>{thread.path}{thread.line !== undefined ? ` · Line ${thread.line}` : ""}</small>
                  <ThreadCard thread={thread} onReply={reply(thread)} onSend={() => onSend(threadChip(detail, thread))} onResolve={resolver(thread)} canEdit={canEdit} onEdit={onEdit} />
                </div>
              )) : null}
            </section>
          ) : null}
          {current ? (
            <header className="pr-file-header">
              <span className={`review-file-status ${current.status}`}>{STATUS_LETTERS[current.status]}</span>
              <strong title={current.path}>{split(current.path).name}</strong>
              {split(current.path).directory ? <span className="pr-file-dir">{split(current.path).directory}</span> : null}
              {current.previousPath ? <span className="pr-file-dir">from {current.previousPath}</span> : null}
              <span className="spacer" />
              <span className="stat-add">+{current.added}</span>
              <span className="stat-del">−{current.removed}</span>
              <label className={`pr-viewed ${current.viewed === "dismissed" && !pending.has(current.path) ? "dismissed" : ""}`} {...tooltipProps(!writes.viewed ? READ_ONLY_REASON : current.viewed === "dismissed" ? "This file has been pushed to since you marked it viewed." : undefined)}>
                <input type="checkbox" checked={isViewed(current)} disabled={!writes.viewed} onChange={() => void toggleViewed(current)} />
                {current.viewed === "dismissed" && !pending.has(current.path) ? "Changed" : "Viewed"}
              </label>
              <button className="icon-button compact" aria-label="Previous file" onClick={() => step(-1)}><ChevronLeft size={14} /></button>
              <button className="icon-button compact" aria-label="Next file" onClick={() => step(1)}><ChevronRight size={14} /></button>
            </header>
          ) : null}
          <div className="pr-diff">
            <DiffView key={current?.path} {...(diff ? { diff } : {})} mode={layout} wrap={wrap} {...(current ? { path: current.path } : {})} {...(lines ? { lines } : {})} />
          </div>
        </main>
        {treeOpen ? (
          <aside className="pr-file-list" aria-label="Changed files">
            {ordered.map((file) => {
              const { name, directory } = split(file.path);
              const count = threadCounts.get(file.path) ?? 0;
              return (
                <button key={file.path} className={`pr-file-row ${file.path === current?.path ? "active" : ""} ${isViewed(file) ? "viewed" : ""}`} aria-current={file.path === current?.path} title={file.path} onClick={() => setSelected(file.path)}>
                  <span className={`review-file-status ${file.status}`}>{STATUS_LETTERS[file.status]}</span>
                  <span className="pr-file-name">{name}{directory ? <small>{directory}</small> : null}</span>
                  {count > 0 ? <span className="pr-file-threads" aria-label={`${count} conversations`}><MessageSquare size={10} aria-hidden="true" />{count}</span> : null}
                  {isViewed(file) ? <span className="pr-file-viewed" aria-label="viewed">✓</span> : null}
                </button>
              );
            })}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
