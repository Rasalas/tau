import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { errorMessage, Popover, Spinner } from "tau";
import type { PendingReviewComment, PullRequestReviewEvent, RequestService } from "./protocol.js";

const EVENTS: Array<{ value: PullRequestReviewEvent; label: string; hint: string }> = [
  { value: "comment", label: "Comment", hint: "Feedback without a verdict." },
  { value: "approve", label: "Approve", hint: "Ready to merge as it is." },
  { value: "request-changes", label: "Request changes", hint: "Has to change before it merges." },
];

/**
 * T3 Code's one composer for both: a plain comment on the request, or a
 * review that carries a verdict, a summary and every line comment held for
 * it. GitLab takes no request for changes through its API, so it offers two.
 */
export function ReviewComposer({ service, pending, onRemovePending, onComment, onReview, onCancel }: {
  service: RequestService;
  pending: readonly PendingReviewComment[];
  onRemovePending(id: string): void;
  onComment(text: string): Promise<void>;
  onReview(event: PullRequestReviewEvent, text: string): Promise<void>;
  onCancel(): void;
}) {
  const [mode, setMode] = useState<"comment" | "review">(pending.length > 0 ? "review" : "comment");
  const [event, setEvent] = useState<PullRequestReviewEvent>("comment");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const events = service === "gitlab" ? EVENTS.filter((entry) => entry.value !== "request-changes") : EVENTS;
  const noun = service === "gitlab" ? "merge request" : "pull request";
  const ready = mode === "comment" ? Boolean(text.trim()) : event === "approve" || Boolean(text.trim()) || pending.length > 0;
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (mode === "comment") await onComment(text.trim()); else await onReview(event, text.trim());
      setText("");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pr-composer" role="dialog" aria-label={mode === "comment" ? `Comment on the ${noun}` : `Review the ${noun}`}>
      <div className="toggle-group" role="tablist" aria-label="Comment or review">
        <button role="tab" aria-selected={mode === "comment"} className={mode === "comment" ? "active" : ""} onClick={() => setMode("comment")}>Comment</button>
        <button role="tab" aria-selected={mode === "review"} className={mode === "review" ? "active" : ""} onClick={() => setMode("review")}>
          Review{pending.length > 0 ? ` · ${pending.length}` : ""}
        </button>
      </div>
      <textarea
        autoFocus
        aria-label={mode === "comment" ? "Comment" : "Review summary"}
        placeholder={mode === "comment" ? "Leave a comment" : "Summarize your review (optional for an approval)"}
        value={text}
        rows={4}
        disabled={busy}
        onChange={(change) => setText(change.target.value)}
        onKeyDown={(key) => {
          if (key.key === "Escape") { key.preventDefault(); key.stopPropagation(); onCancel(); }
          if (key.key === "Enter" && (key.metaKey || key.ctrlKey)) { key.preventDefault(); void submit(); }
        }}
      />
      {mode === "review" ? (
        <>
          <div className="pr-verdicts" role="radiogroup" aria-label="Verdict">
            {events.map((entry) => (
              <label key={entry.value} className={`pr-verdict ${event === entry.value ? "active" : ""}`} title={entry.hint}>
                <input type="radio" name="pr-verdict" checked={event === entry.value} onChange={() => setEvent(entry.value)} /> {entry.label}
              </label>
            ))}
          </div>
          {pending.length > 0 ? (
            <ul className="pr-pending" aria-label="Line comments in this review">
              {pending.map((comment) => (
                <li key={comment.id}>
                  <code title={comment.path}>{comment.path.split("/").at(-1)}:{comment.line}</code>
                  <span>{comment.body}</span>
                  <button className="icon-button compact" aria-label={`Remove the comment on ${comment.path}:${comment.line}`} title="Remove" onClick={() => onRemovePending(comment.id)}><X size={11} /></button>
                </li>
              ))}
            </ul>
          ) : <p className="pr-empty">Add line comments from the Code tab with "Add to review".</p>}
        </>
      ) : null}
      {error ? <p className="pr-error" role="alert">{error}</p> : null}
      <footer>
        <span>⌘↵ to send</span>
        <button className="text-button" disabled={busy} onClick={onCancel}>Cancel</button>
        <button className="mini-button" disabled={busy || !ready} onClick={() => void submit()}>
          {busy ? "Sending…" : mode === "comment" ? "Comment" : `Submit review${pending.length > 0 ? ` (${pending.length})` : ""}`}
        </button>
      </footer>
    </div>
  );
}

/**
 * A "+" beside the reviewers or labels: a filtered list of what the host
 * offers, and for reviewers any login typed in full.
 */
export function ChipPicker({ label, taken, load, allowTyped, onAdd }: {
  label: string;
  taken: readonly string[];
  load(): Promise<string[]>;
  allowTyped?: boolean;
  onAdd(name: string): Promise<void>;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [options, setOptions] = useState<string[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open || options) return;
    let alive = true;
    load().then((names) => { if (alive) setOptions(names); }, (reason: unknown) => { if (alive) { setOptions([]); setError(errorMessage(reason)); } });
    return () => { alive = false; };
  }, [load, open, options]);
  const lowered = filter.trim().toLowerCase();
  const shown = (options ?? []).filter((name) => !taken.includes(name) && name.toLowerCase().includes(lowered)).slice(0, 50);
  const add = async (name: string) => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try { await onAdd(name.trim()); setOpen(false); setFilter(""); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  };
  return (
    <>
      <button ref={anchor} className="icon-button compact pr-chip-add" aria-label={label} title={label} aria-expanded={open} onClick={() => setOpen(!open)}><Plus size={11} /></button>
      {open ? (
        <Popover anchor={anchor} label={label} className="pr-picker" onClose={() => setOpen(false)}>
          <input
            autoFocus
            aria-label={`${label}: filter`}
            placeholder={allowTyped ? "Filter, or type a login" : "Filter"}
            value={filter}
            disabled={busy}
            onChange={(change) => setFilter(change.target.value)}
            onKeyDown={(key) => {
              if (key.key !== "Enter") return;
              key.preventDefault();
              const exact = shown.find((name) => name.toLowerCase() === lowered) ?? shown[0];
              void add(allowTyped && !exact ? filter : exact ?? "");
            }}
          />
          {!options ? <p className="pr-empty"><Spinner size="xs" label="Loading" /> Loading…</p> : null}
          {options && shown.length === 0 ? <p className="pr-empty">{allowTyped && filter.trim() ? `Enter asks ${filter.trim()}.` : "Nothing to add."}</p> : null}
          <ul role="listbox" aria-label={label}>
            {shown.map((name) => (
              <li key={name}><button role="option" aria-selected={false} disabled={busy} onClick={() => void add(name)}>{name}</button></li>
            ))}
          </ul>
          {error ? <p className="pr-error" role="alert">{error}</p> : null}
        </Popover>
      ) : null}
    </>
  );
}
