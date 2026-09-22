import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Info, MessageSquare, PanelRightClose, PanelRightOpen } from "lucide-react";
import { DiffView, errorMessage, getClientStorage, type DiffLineSlot, type UiDiffLine, type WorkbenchActions } from "tau";
import type { PullRequestDetail, PullRequestFile, PullRequestFiles, PullRequestThread, ReviewCommentChip } from "./protocol.js";
import type { PullRequestCommentInput } from "./pull-request-client.js";
import { anchorThreads, lineKeys, orderFiles, shortNoun, threadChip } from "./pull-request-logic.js";
import { ReplyBox, ThreadCard } from "./pull-request-parts.js";

const TREE_KEY = "tau.review.pr-file-tree-open";

interface Draft {
  path: string;
  line: number;
  side: "new" | "old";
  code: string;
}

const STATUS_LETTERS: Record<PullRequestFile["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };

function split(path: string): { name: string; directory: string } {
  const at = path.lastIndexOf("/");
  return at < 0 ? { name: path, directory: "" } : { name: path.slice(at + 1), directory: path.slice(0, at) };
}

function mark(line: UiDiffLine): string {
  return `${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "} ${line.text}`;
}

/** A line comment the user wants the agent to see, not the host. */
function draftChip(detail: PullRequestDetail, draft: Draft, body: string): ReviewCommentChip {
  const place = `${draft.path}:${draft.line}${draft.side === "old" ? " (before the change)" : ""}`;
  return {
    kind: "text-excerpt",
    label: `${split(draft.path).name}:${draft.line}`,
    payload: { source: `Comment on ${shortNoun(detail.ref.service)} #${detail.ref.number} at ${place}`, text: `${body}\n\n\`\`\`diff\n${draft.code}\n\`\`\`` },
  };
}

/**
 * The request's files, one diff at a time beside the file list: review
 * threads under their lines, a new comment from a line's gutter button, and
 * a viewed mark per file that moves on to the next file still to read.
 */
export function PullRequestCode({ detail, files, filesError, threads, focusPath, actions, load, onViewed, onComment, onSend }: {
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
}) {
  const [selected, setSelected] = useState<string>();
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const [treeOpen, setTreeOpen] = useState(() => getClientStorage()?.get(TREE_KEY) !== "false");
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [draft, setDraft] = useState<Draft>();
  const [looseOpen, setLooseOpen] = useState(true);

  useEffect(() => { if (!files && !filesError) void load(false); }, [files, filesError, load]);
  useEffect(() => { if (focusPath) setSelected(focusPath); }, [focusPath]);

  const ordered = useMemo(() => orderFiles(files?.files ?? []), [files]);
  const isViewed = (file: PullRequestFile) => pending.get(file.path) ?? file.viewed === "viewed";
  const current = ordered.find((file) => file.path === selected) ?? ordered.find((file) => !isViewed(file)) ?? ordered[0];
  const diff = useMemo(() => files?.diffs.find((entry) => entry.path === current?.path), [current?.path, files]);
  const { anchored, loose } = useMemo(() => anchorThreads(threads, files?.diffs ?? []), [files, threads]);
  const threadCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const thread of threads) counts.set(thread.path, (counts.get(thread.path) ?? 0) + 1);
    return counts;
  }, [threads]);
  const viewedCount = ordered.filter(isViewed).length;

  const reply = (thread: PullRequestThread) => (text: string) => onComment({ threadId: thread.id, body: text });

  const lines = useMemo<DiffLineSlot | undefined>(() => {
    if (!current) return undefined;
    const at = (line: UiDiffLine) => lineKeys(current.path, line).flatMap((key) => anchored.get(key) ?? []);
    const drafting = (line: UiDiffLine) => draft?.path === current.path && (draft.side === "new" ? line.newLine : line.kind === "removed" ? line.oldLine : undefined) === draft.line;
    return {
      onAction: ({ path, line }) => {
        const side = line.newLine !== undefined ? "new" : "old";
        const number = side === "new" ? line.newLine : line.oldLine;
        if (number !== undefined) setDraft({ path, line: number, side, code: mark(line) });
      },
      actionLabel: ({ line }) => line.newLine !== undefined ? `Comment on line ${line.newLine}` : `Comment on removed line ${line.oldLine}`,
      count: ({ line }) => at(line).length,
      selected: ({ line }) => drafting(line),
      render: ({ line }) => {
        const here = at(line);
        const editing = drafting(line) ? draft : undefined;
        if (here.length === 0 && !editing) return null;
        return (
          <div className="pr-line-slot">
            {here.map((thread) => <ThreadCard key={thread.id} thread={thread} onReply={reply(thread)} onSend={() => onSend(threadChip(detail, thread))} />)}
            {editing ? (
              <ReplyBox
                label={`Comment on line ${editing.line}`}
                placeholder="Leave a comment"
                submitLabel="Comment"
                onSubmit={async (text) => { await onComment({ path: editing.path, line: editing.line, side: editing.side, body: text }); setDraft(undefined); }}
                onCancel={() => setDraft(undefined)}
                extra={(text) => (
                  <button className="text-button" disabled={!text.trim()} title="Hand the comment to the agent instead of posting it" onClick={() => { onSend(draftChip(detail, editing, text.trim())); setDraft(undefined); }}>
                    Send to agent
                  </button>
                )}
              />
            ) : null}
          </div>
        );
      },
    };
    // `reply` and `onSend` close over stable props; the slot follows what it draws.
  }, [anchored, current, detail, draft]);

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
  if (ordered.length === 0) return <p className="pr-empty pr-pad">This {detail.ref.service === "gitlab" ? "merge" : "pull"} request has no file changes.</p>;

  return (
    <div className="pr-code">
      <header className="pr-code-toolbar">
        <span>{ordered.length} {ordered.length === 1 ? "file" : "files"}</span>
        <span className="pr-viewed-count" title={files.viewedOn === "local" ? "GitLab keeps no viewed marks, so these are stored in this Tau only." : undefined}>
          {viewedCount} / {ordered.length} viewed{files.viewedOn === "local" ? <> in Tau <Info size={11} aria-hidden="true" /></> : null}
        </span>
        <span className="spacer" />
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
                  <ThreadCard thread={thread} onReply={reply(thread)} onSend={() => onSend(threadChip(detail, thread))} />
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
              <label className={`pr-viewed ${current.viewed === "dismissed" && !pending.has(current.path) ? "dismissed" : ""}`} title={current.viewed === "dismissed" ? "This file has been pushed to since you marked it viewed." : undefined}>
                <input type="checkbox" checked={isViewed(current)} onChange={() => void toggleViewed(current)} />
                {current.viewed === "dismissed" && !pending.has(current.path) ? "Changed" : "Viewed"}
              </label>
              <button className="icon-button compact" aria-label="Previous file" onClick={() => step(-1)}><ChevronLeft size={14} /></button>
              <button className="icon-button compact" aria-label="Next file" onClick={() => step(1)}><ChevronRight size={14} /></button>
            </header>
          ) : null}
          <div className="pr-diff">
            <DiffView key={current?.path} {...(diff ? { diff } : {})} mode={layout} {...(current ? { path: current.path } : {})} {...(lines ? { lines } : {})} />
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
