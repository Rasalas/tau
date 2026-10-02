import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, CircleCheck, CircleDashed, CircleDot, CircleX, LoaderCircle, MessageSquare, Pencil, Send } from "lucide-react";
import { errorMessage, Markdown, type WorkbenchActions } from "tau";
import type { ComposerContextChips, PullRequestCheckStatus, PullRequestChip, PullRequestComment, PullRequestThread, ReviewCommentChip } from "./protocol.js";
import { relativeTime, ROLLUP_TITLES, type ChecksRollup } from "./pull-request-logic.js";
import { githubHtml } from "./github-html.js";

export function CheckIcon({ status, size = 13 }: { status: PullRequestCheckStatus; size?: number }) {
  const props = { size, className: `pr-check-icon ${status}`, "aria-hidden": true } as const;
  switch (status) {
    case "pending": return <LoaderCircle {...props} className={`${props.className} spinning`} />;
    case "action-required": return <CircleDot {...props} />;
    case "passed": return <CircleCheck {...props} />;
    case "failed":
    case "cancelled": return <CircleX {...props} />;
    default: return <CircleDashed {...props} />;
  }
}

export function RollupIcon({ rollup }: { rollup: ChecksRollup }) {
  const status: PullRequestCheckStatus = rollup === "failing" ? "failed" : rollup === "pending" ? "pending" : "passed";
  return <span className="pr-rollup" title={ROLLUP_TITLES[rollup]}><CheckIcon status={status} /></span>;
}

/** Puts a chip into the composer on screen, or its words when Composer Context is off. */
export function handOver(chip: ReviewCommentChip | PullRequestChip, chips: ComposerContextChips | undefined, actions: WorkbenchActions): void {
  if (chips) {
    try {
      chips.addChip(chip);
      actions.focusComposer();
      return;
    } catch (error) {
      actions.notify(`The composer did not take it: ${errorMessage(error)}`);
      return;
    }
  }
  const text = chip.kind === "pull-request"
    ? `Pull request [#${chip.payload.number}](${chip.payload.url}): ${chip.payload.title}`
    : `From ${chip.payload.source}:\n${chip.payload.text.split("\n").map((line) => line ? `> ${line}` : ">").join("\n")}`;
  const draft = actions.composerDraft();
  actions.focusComposer(draft.trim() ? `${draft}\n\n${text}` : text);
}

const VERDICT_WORDS: Record<string, string> = {
  approved: "approved",
  "changes-requested": "requested changes",
  dismissed: "dismissed",
  commented: "reviewed",
  pending: "pending",
};

export function verdictWord(comment: PullRequestComment): string {
  if (comment.kind === "review") return VERDICT_WORDS[comment.verdict ?? "commented"] ?? "reviewed";
  return "commented";
}

/**
 * One comment: who, when, what it decided, where in the code, the text, and
 * a way to hand it to the composer.
 */
export function CommentCard({ comment, where, outdated, onSend, onOpenWhere, onEdit, actions, children }: {
  comment: PullRequestComment;
  where?: string;
  outdated?: boolean;
  onSend?(): void;
  onOpenWhere?(): void;
  /** Only for the signed-in account's own comments. */
  onEdit?(body: string): Promise<void>;
  actions: WorkbenchActions;
  children?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <article className="pr-comment" aria-label={`${comment.author.login} ${verdictWord(comment)}`}>
      <header>
        <strong>{comment.author.login}</strong>
        {comment.author.bot ? <span className="pr-tag">bot</span> : null}
        <span className={`pr-verb ${comment.verdict ?? ""}`}>{verdictWord(comment)}</span>
        {comment.url ? (
          <button className="pr-time" title="Open on the host" onClick={() => actions.openExternal(comment.url!)}>{relativeTime(comment.createdAt)}</button>
        ) : <span className="pr-time">{relativeTime(comment.createdAt)}</span>}
        <span className="spacer" />
        {onEdit && !editing ? <button className="icon-button compact" aria-label="Edit comment" title="Edit comment" onClick={() => setEditing(true)}><Pencil size={11} /></button> : null}
        {onSend ? <button className="icon-button compact" aria-label="Send to composer" title="Send to composer" onClick={onSend}><Send size={12} /></button> : null}
      </header>
      {where ? (
        <p className="pr-where">
          {onOpenWhere ? <button className="text-button" onClick={onOpenWhere}>{where}</button> : <span>{where}</span>}
          {outdated ? <span className="pr-tag">Outdated</span> : null}
        </p>
      ) : null}
      {editing && onEdit
        ? <MarkdownEditor label="Edit comment" initial={comment.body} onSave={async (body) => { await onEdit(body); setEditing(false); }} onCancel={() => setEditing(false)} />
        : comment.body.trim() ? <div className="pr-comment-body"><Markdown html={githubHtml}>{comment.body}</Markdown></div> : null}
      {children}
    </article>
  );
}

/** ⌘↵ sends, Escape cancels; the text stays until the host took it. */
export function ReplyBox({ label, placeholder, submitLabel, onSubmit, onCancel, extra, autoFocus = true }: {
  label: string;
  placeholder: string;
  submitLabel: string;
  /** Absent where the host takes no such comment; `extra` still hands the text elsewhere. */
  onSubmit?(text: string): Promise<void>;
  onCancel(): void;
  extra?: (text: string) => ReactNode;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    if (!onSubmit || !text.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSubmit(text.trim());
      setText("");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pr-reply" role="group" aria-label={label}>
      <textarea
        autoFocus={autoFocus}
        aria-label={label}
        placeholder={placeholder}
        value={text}
        rows={3}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
        }}
      />
      {error ? <p className="pr-error" role="alert">{error}</p> : null}
      <footer>
        {onSubmit ? <span>⌘↵ to send</span> : null}
        {extra?.(text)}
        <button className="text-button" disabled={busy} onClick={onCancel}>Cancel</button>
        {onSubmit ? <button className="mini-button" disabled={busy || !text.trim()} onClick={() => void submit()}>{busy ? "Posting…" : submitLabel}</button> : null}
      </footer>
    </div>
  );
}

/** A review thread on a line: its state as the toggle, its comments, a reply and a hand-over. */
export function ThreadCard({ thread, onReply, onSend, onResolve, canEdit, onEdit }: {
  thread: PullRequestThread;
  /** Absent where the host takes no replies. */
  onReply?: ((text: string) => Promise<void>) | undefined;
  onSend(): void;
  /** Marks the conversation resolved, or opens it again; absent where the host cannot. */
  onResolve?: ((resolved: boolean) => Promise<void>) | undefined;
  canEdit?(comment: PullRequestComment): boolean;
  onEdit?(comment: PullRequestComment, body: string): Promise<void>;
}) {
  const [open, setOpen] = useState(!thread.resolved);
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string>();
  const count = thread.comments.length;
  const resolve = async () => {
    if (!onResolve || resolving) return;
    setResolving(true);
    setError(undefined);
    try { await onResolve(!thread.resolved); } catch (reason) { setError(errorMessage(reason)); } finally { setResolving(false); }
  };
  return (
    <section className={`pr-thread ${thread.resolved ? "resolved" : ""}`} aria-label={`Conversation on ${thread.path}${thread.line !== undefined ? `:${thread.line}` : ""}`}>
      <header>
        <button className="pr-thread-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {thread.resolved ? <CircleCheck size={12} className="pr-check-icon passed" /> : <MessageSquare size={12} />}
          {thread.resolved ? "Resolved" : "Open"} · {count} {count === 1 ? "comment" : "comments"}
        </button>
        {thread.outdated ? <span className="pr-tag">outdated</span> : null}
        <span className="spacer" />
        {onResolve ? <button className="text-button pr-resolve" disabled={resolving} onClick={() => void resolve()}>{resolving ? "…" : thread.resolved ? "Unresolve" : "Resolve"}</button> : null}
        <button className="icon-button compact" aria-label="Send conversation to composer" title="Send to composer" onClick={onSend}><Send size={12} /></button>
      </header>
      {error ? <p className="pr-error" role="alert">{error}</p> : null}
      {open ? <>
        {thread.comments.map((comment) => (
          <div key={comment.id} className="pr-thread-comment">
            <p>
              <strong>{comment.author.login}</strong> <span className="pr-time">{relativeTime(comment.createdAt)}</span>
              {onEdit && canEdit?.(comment) && editing !== comment.id ? <button className="icon-button compact" aria-label="Edit comment" title="Edit comment" onClick={() => setEditing(comment.id)}><Pencil size={11} /></button> : null}
            </p>
            {editing === comment.id && onEdit
              ? <MarkdownEditor label="Edit comment" initial={comment.body} onSave={async (body) => { await onEdit(comment, body); setEditing(undefined); }} onCancel={() => setEditing(undefined)} />
              : comment.body.trim() ? <div className="pr-comment-body"><Markdown html={githubHtml}>{comment.body}</Markdown></div> : null}
          </div>
        ))}
        {!onReply ? null : replying
          ? <ReplyBox label="Reply to this conversation" placeholder="Reply" submitLabel="Reply" onSubmit={async (text) => { await onReply(text); setReplying(false); }} onCancel={() => setReplying(false)} />
          : <button className="text-button pr-reply-open" onClick={() => setReplying(true)}>Reply</button>}
      </> : null}
    </section>
  );
}

/** Write or preview; ⌘↵ saves and Escape cancels. */
export function MarkdownEditor({ initial, label, allowEmpty = false, onSave, onCancel }: {
  initial: string;
  label: string;
  allowEmpty?: boolean;
  onSave(text: string): Promise<void>;
  onCancel(): void;
}) {
  const [text, setText] = useState(initial);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const save = async () => {
    if (busy || (!allowEmpty && !text.trim())) return;
    setBusy(true);
    setError(undefined);
    try { await onSave(text); } catch (reason) { setError(errorMessage(reason)); setBusy(false); }
  };
  return (
    <div className="pr-editor" role="group" aria-label={label}>
      <div className="toggle-group" role="tablist" aria-label="Editor mode">
        <button role="tab" aria-selected={!preview} className={preview ? "" : "active"} onClick={() => setPreview(false)}>Write</button>
        <button role="tab" aria-selected={preview} className={preview ? "active" : ""} onClick={() => setPreview(true)}>Preview</button>
      </div>
      {preview
        ? <div className="pr-editor-preview">{text.trim() ? <Markdown html={githubHtml}>{text}</Markdown> : <p className="pr-empty">Nothing to preview.</p>}</div>
        : <textarea
          autoFocus
          aria-label={label}
          rows={6}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); }
          }}
        />}
      {error ? <p className="pr-error" role="alert">{error}</p> : null}
      <footer>
        <button className="text-button" disabled={busy} onClick={onCancel}>Cancel</button>
        <button className="mini-button" disabled={busy || (!allowEmpty && !text.trim())} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
      </footer>
    </div>
  );
}
