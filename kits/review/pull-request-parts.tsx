import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, CircleCheck, CircleDashed, CircleDot, CircleX, ExternalLink, LoaderCircle, MessageSquare, Send } from "lucide-react";
import { errorMessage, Markdown, type WorkbenchActions } from "tau";
import type { ComposerContextChips, PullRequestCheck, PullRequestCheckStatus, PullRequestChip, PullRequestComment, PullRequestThread, ReviewCommentChip } from "./protocol.js";
import { CHECK_LABELS, relativeTime, ROLLUP_TITLES, type ChecksRollup } from "./pull-request-logic.js";

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

export function ChecksList({ checks, actions }: { checks: readonly PullRequestCheck[]; actions: WorkbenchActions }) {
  if (checks.length === 0) return <p className="pr-empty">No checks reported.</p>;
  return (
    <ul className="pr-checks" aria-label="Checks">
      {checks.map((check) => (
        <li key={check.name}>
          <button className="pr-check" disabled={!check.url} title={check.description ?? check.name} onClick={() => check.url && actions.openExternal(check.url)}>
            <CheckIcon status={check.status} />
            <span className="pr-check-name">{check.name}</span>
            {check.workflow && !check.name.startsWith(`${check.workflow} / `) ? <small>{check.workflow}</small> : null}
            <span className={`pr-check-status ${check.status}`}>{CHECK_LABELS[check.status]}</span>
            {check.url ? <ExternalLink size={11} aria-hidden="true" /> : null}
          </button>
        </li>
      ))}
    </ul>
  );
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
export function CommentCard({ comment, where, outdated, onSend, onOpenWhere, actions, children }: {
  comment: PullRequestComment;
  where?: string;
  outdated?: boolean;
  onSend?(): void;
  onOpenWhere?(): void;
  actions: WorkbenchActions;
  children?: ReactNode;
}) {
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
        {onSend ? <button className="icon-button compact" aria-label="Send to composer" title="Send to composer" onClick={onSend}><Send size={12} /></button> : null}
      </header>
      {where ? (
        <p className="pr-where">
          {onOpenWhere ? <button className="text-button" onClick={onOpenWhere}>{where}</button> : <span>{where}</span>}
          {outdated ? <span className="pr-tag">Outdated</span> : null}
        </p>
      ) : null}
      {comment.body.trim() ? <div className="pr-comment-body"><Markdown>{comment.body}</Markdown></div> : null}
      {children}
    </article>
  );
}

/** ⌘↵ sends, Escape cancels; the text stays until the host took it. */
export function ReplyBox({ label, placeholder, submitLabel, onSubmit, onCancel, extra, autoFocus = true }: {
  label: string;
  placeholder: string;
  submitLabel: string;
  onSubmit(text: string): Promise<void>;
  onCancel(): void;
  extra?: (text: string) => ReactNode;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    if (!text.trim() || busy) return;
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
        <span>⌘↵ to send</span>
        {extra?.(text)}
        <button className="text-button" disabled={busy} onClick={onCancel}>Cancel</button>
        <button className="mini-button" disabled={busy || !text.trim()} onClick={() => void submit()}>{busy ? "Posting…" : submitLabel}</button>
      </footer>
    </div>
  );
}

/** A review thread on a line: its state as the toggle, its comments, a reply and a hand-over. */
export function ThreadCard({ thread, onReply, onSend }: {
  thread: PullRequestThread;
  onReply(text: string): Promise<void>;
  onSend(): void;
}) {
  const [open, setOpen] = useState(!thread.resolved);
  const [replying, setReplying] = useState(false);
  const count = thread.comments.length;
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
        <button className="icon-button compact" aria-label="Send conversation to composer" title="Send to composer" onClick={onSend}><Send size={12} /></button>
      </header>
      {open ? <>
        {thread.comments.map((comment) => (
          <div key={comment.id} className="pr-thread-comment">
            <p><strong>{comment.author.login}</strong> <span className="pr-time">{relativeTime(comment.createdAt)}</span></p>
            {comment.body.trim() ? <div className="pr-comment-body"><Markdown>{comment.body}</Markdown></div> : null}
          </div>
        ))}
        {replying
          ? <ReplyBox label="Reply to this conversation" placeholder="Reply" submitLabel="Reply" onSubmit={async (text) => { await onReply(text); setReplying(false); }} onCancel={() => setReplying(false)} />
          : <button className="text-button pr-reply-open" onClick={() => setReplying(true)}>Reply</button>}
      </> : null}
    </section>
  );
}

/** Write or preview; ⌘↵ saves and Escape cancels, as T3 Code's editor does. */
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
        ? <div className="pr-editor-preview">{text.trim() ? <Markdown>{text}</Markdown> : <p className="pr-empty">Nothing to preview.</p>}</div>
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
