import { useMemo } from "react";
import { MessageSquare, Send, Trash2, X } from "lucide-react";
import type { DiffLineSlot, WorkbenchActions } from "tau";
import {
  commentChip,
  commentLocation,
  commentsAsText,
  commentsEndingAt,
  lineNumber,
  type CommentDraft,
  type ReviewComment,
  type ReviewCommentStore,
  type ReviewCommentsState,
} from "./comments.js";
import type { ComposerContextChips } from "./protocol.js";

function CommentEditor({ store, draft }: { store: ReviewCommentStore; draft: CommentDraft }) {
  return (
    <div className="review-comment-editor" role="group" aria-label={`Comment on ${commentLocation(draft)}`}>
      <small>{commentLocation(draft)}</small>
      <textarea
        autoFocus
        placeholder="Leave a comment for the agent…"
        aria-label="Comment"
        value={draft.body}
        onChange={(event) => store.setDraftBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); store.cancelDraft(); }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); store.saveDraft(); }
        }}
      />
      <footer>
        <span>⌘↵ to comment · ⇧-click another line for a range</span>
        <button className="text-button" onClick={() => store.cancelDraft()}>Cancel</button>
        <button className="mini-button" disabled={!draft.body.trim()} onClick={() => store.saveDraft()}>Comment</button>
      </footer>
    </div>
  );
}

function CommentNote({ comment, onDelete }: { comment: ReviewComment; onDelete(): void }) {
  return (
    <div className="review-comment-note">
      <MessageSquare size={12} aria-hidden="true" />
      <p>{comment.body}</p>
      <button className="icon-button compact" aria-label={`Delete comment on ${commentLocation(comment)}`} onClick={onDelete}><Trash2 size={12} /></button>
    </div>
  );
}

/** The line seam Review fills: the gutter starts a comment, and comments and the open one sit under their last line. */
export function useCommentLines(store: ReviewCommentStore, state: ReviewCommentsState): DiffLineSlot {
  return useMemo<DiffLineSlot>(() => {
    const { comments, draft } = state;
    const inDraft = (path: string, line: Parameters<typeof lineNumber>[0]) => {
      if (!draft || draft.path !== path) return false;
      const number = lineNumber(line, draft.side);
      return number !== undefined && number >= draft.startLine && number <= draft.endLine;
    };
    return {
      onAction: ({ path, line }, event) => store.lineAction(path, line, event.shiftKey),
      actionLabel: ({ line }) => line.newLine !== undefined ? `Comment on line ${line.newLine}` : `Comment on removed line ${line.oldLine}`,
      count: ({ path, line }) => commentsEndingAt(comments, path, line).length,
      selected: ({ path, line }) => inDraft(path, line),
      render: ({ path, line }) => {
        const notes = commentsEndingAt(comments, path, line);
        const editing = draft && draft.path === path && lineNumber(line, draft.side) === draft.endLine;
        if (notes.length === 0 && !editing) return null;
        return <>
          {notes.map((comment) => <CommentNote key={comment.id} comment={comment} onDelete={() => store.remove([comment.id])} />)}
          {editing ? <CommentEditor store={store} draft={draft} /> : null}
        </>;
      },
    };
  }, [state, store]);
}

export function CommentsToolbar({ store, state, onSend }: { store: ReviewCommentStore; state: ReviewCommentsState; onSend(): void }) {
  const count = state.comments.length;
  return <>
    <button
      className={`text-button review-comments-action ${state.panelOpen ? "active" : ""}`}
      aria-pressed={state.panelOpen}
      onClick={() => store.setPanelOpen(!state.panelOpen)}
    ><MessageSquare size={12} /> {count} {count === 1 ? "comment" : "comments"}</button>
    {count > 0 ? <button className="text-button review-comments-send" onClick={onSend}><Send size={12} /> Send to composer</button> : null}
  </>;
}

export function CommentsPanel({ store, state, onSend }: { store: ReviewCommentStore; state: ReviewCommentsState; onSend(): void }) {
  if (!state.panelOpen) return null;
  return (
    <aside className="review-comments" aria-label="Review comments">
      <header>
        <strong>Comments</strong>
        <button className="icon-button compact" aria-label="Close comments" onClick={() => store.setPanelOpen(false)}><X size={13} /></button>
      </header>
      {state.comments.length === 0
        ? <p>Hover a line and press + to comment on it; ⇧-click a second line to cover a range. Comments go to the composer as context for your next prompt.</p>
        : state.comments.map((comment) => <article key={comment.id}>
          <small>{commentLocation(comment)}</small>
          <p>{comment.body}</p>
          <button className="text-button" onClick={() => store.remove([comment.id])}>Delete</button>
        </article>)}
      {state.comments.length > 0 ? <footer>
        <button className="primary" onClick={onSend}><Send size={12} /> Send {state.comments.length} to composer</button>
      </footer> : null}
    </aside>
  );
}

/** How long the hand-off waits for the composer to come back on screen: about a second of frames. */
const HANDOFF_FRAMES = 60;

/**
 * Hands comments to the composer and drops the ones it took. The review
 * covers the composer, so the chips wait for it to mount again; without
 * Composer Context the same words go into the draft as text.
 */
export function handOffComments(comments: readonly ReviewComment[], options: {
  chips?: ComposerContextChips;
  actions: WorkbenchActions;
  remove(ids: readonly string[]): void;
  nextFrame?(run: () => void): void;
}): void {
  const { chips, actions, remove } = options;
  const nextFrame = options.nextFrame ?? ((run: () => void) => { requestAnimationFrame(run); });
  if (comments.length === 0) return;
  if (!chips) {
    const draft = actions.composerDraft();
    const text = commentsAsText(comments);
    actions.focusComposer(draft.trim() ? `${draft}\n\n${text}` : text);
    remove(comments.map((comment) => comment.id));
    return;
  }
  let frames = 0;
  const attempt = () => {
    const taken: string[] = [];
    for (const comment of comments) {
      try {
        chips.addChip(commentChip(comment));
        taken.push(comment.id);
      } catch (error) {
        if (taken.length > 0 || frames >= HANDOFF_FRAMES) {
          if (taken.length > 0) remove(taken);
          actions.notify(`Some review comments stayed in the review: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        frames += 1;
        nextFrame(attempt);
        return;
      }
    }
    remove(taken);
    actions.focusComposer();
  };
  attempt();
}
