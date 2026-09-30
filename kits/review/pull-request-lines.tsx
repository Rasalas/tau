import { useMemo, useState } from "react";
import { X } from "lucide-react";
import type { DiffLineSlot, UiDiffLine, UiFileDiff } from "tau";
import { providerInfo, type PendingReviewComment, type PullRequestComment, type PullRequestDetail, type PullRequestThread, type ReviewCommentChip } from "./protocol.js";
import type { PullRequestCommentInput } from "./pull-request-client.js";
import { anchorThreads, lineKeys, shortNoun, threadChip, threadKey } from "./pull-request-logic.js";
import { ReplyBox, ThreadCard } from "./pull-request-parts.js";
import type { PullRequestWrites } from "./pull-request-writes.js";
import { baseName, lineText } from "./review-lines.js";

interface Draft {
  path: string;
  line: number;
  side: "new" | "old";
  code: string;
}

/** A line comment the user wants the agent to see, not the host. */
function draftChip(detail: PullRequestDetail, draft: Draft, body: string): ReviewCommentChip {
  const place = `${draft.path}:${draft.line}${draft.side === "old" ? " (before the change)" : ""}`;
  return {
    kind: "text-excerpt",
    label: `${baseName(draft.path)}:${draft.line}`,
    payload: { source: `Comment on ${shortNoun(detail.ref.service)} #${detail.ref.number} at ${place}`, text: `${body}\n\n\`\`\`diff\n${draft.code}\n\`\`\`` },
  };
}

/**
 * What a pull request hangs on the lines of its diffs: review threads under
 * their lines, a comment box from a line's gutter button, and the comments
 * held for the review. `slotFor` gives one file's; `loose` are the threads
 * that no longer sit on a line of the diff.
 */
export function usePullRequestLines({ detail, threads, diffs, reviewComments, writes, onComment, onSend, onPend, onRemovePending, onResolve, canEdit, onEdit }: {
  detail: PullRequestDetail;
  threads: readonly PullRequestThread[];
  diffs: readonly UiFileDiff[];
  reviewComments: readonly PendingReviewComment[];
  writes: PullRequestWrites;
  onComment(input: PullRequestCommentInput): Promise<void>;
  onSend(chip: ReviewCommentChip): void;
  onPend(comment: Omit<PendingReviewComment, "id">): void;
  onRemovePending(id: string): void;
  onResolve(thread: PullRequestThread, resolved: boolean): Promise<void>;
  canEdit(comment: PullRequestComment): boolean;
  onEdit(comment: PullRequestComment, body: string): Promise<void>;
}) {
  const [draft, setDraft] = useState<Draft>();
  const { anchored, loose } = useMemo(() => anchorThreads(threads, diffs), [diffs, threads]);
  const held = useMemo(() => {
    const map = new Map<string, PendingReviewComment[]>();
    for (const comment of reviewComments) {
      const key = threadKey(comment.path, comment.side, comment.line);
      map.set(key, [...map.get(key) ?? [], comment]);
    }
    return map;
  }, [reviewComments]);
  const capabilities = providerInfo(detail.ref.service).capabilities;
  const reply = (thread: PullRequestThread) => capabilities.replies && writes.comment ? (text: string) => onComment({ threadId: thread.id, body: text }) : undefined;
  const resolver = (thread: PullRequestThread) => capabilities.resolve && writes.resolve ? (resolved: boolean) => onResolve(thread, resolved) : undefined;

  const slotFor = useMemo(() => (path: string): DiffLineSlot => {
    const at = (line: UiDiffLine) => lineKeys(path, line).flatMap((key) => anchored.get(key) ?? []);
    const heldAt = (line: UiDiffLine) => lineKeys(path, line).flatMap((key) => held.get(key) ?? []);
    const drafting = (line: UiDiffLine) => draft?.path === path && (draft.side === "new" ? line.newLine : line.kind === "removed" ? line.oldLine : undefined) === draft.line;
    return {
      // A line comment only posts or joins a review; a Read-only device reads the threads.
      ...(writes.comment || writes.review ? { onAction: ({ path: at_, line }: { path: string; line: UiDiffLine }) => {
        const side = line.newLine !== undefined ? "new" : "old";
        const number = side === "new" ? line.newLine : line.oldLine;
        if (number !== undefined) setDraft({ path: at_, line: number, side, code: lineText(line) });
      } } : {}),
      actionLabel: ({ line }) => line.newLine !== undefined ? `Comment on line ${line.newLine}` : `Comment on removed line ${line.oldLine}`,
      count: ({ line }) => at(line).length + heldAt(line).length,
      selected: ({ line }) => drafting(line),
      render: ({ line }) => {
        const here = at(line);
        const mine = heldAt(line);
        const editing = drafting(line) ? draft : undefined;
        if (here.length === 0 && mine.length === 0 && !editing) return null;
        return (
          <div className="pr-line-slot">
            {here.map((thread) => <ThreadCard key={thread.id} thread={thread} onReply={reply(thread)} onSend={() => onSend(threadChip(detail, thread))} onResolve={resolver(thread)} canEdit={canEdit} onEdit={onEdit} />)}
            {mine.map((comment) => (
              <div key={comment.id} className="pr-pending-note" aria-label={`Pending comment on line ${comment.line}`}>
                <span className="pr-tag">Pending</span>
                <p>{comment.body}</p>
                <button className="icon-button compact" aria-label="Remove from the review" title="Remove from the review" onClick={() => onRemovePending(comment.id)}><X size={11} /></button>
              </div>
            ))}
            {editing ? (
              <ReplyBox
                label={`Comment on line ${editing.line}`}
                placeholder="Leave a comment"
                submitLabel="Comment"
                {...(capabilities.lineComments ? { onSubmit: async (text: string) => { await onComment({ path: editing.path, line: editing.line, side: editing.side, body: text }); setDraft(undefined); } } : {})}
                onCancel={() => setDraft(undefined)}
                extra={(text) => (
                  <>
                    <button className="text-button" disabled={!text.trim()} title="Hand the comment to the agent instead of posting it" onClick={() => { onSend(draftChip(detail, editing, text.trim())); setDraft(undefined); }}>
                      Send to agent
                    </button>
                    {capabilities.lineComments ? (
                      <button className="text-button" disabled={!text.trim()} title="Hold the comment for your review; it posts when you submit the review" onClick={() => { onPend({ path: editing.path, line: editing.line, side: editing.side, body: text.trim() }); setDraft(undefined); }}>
                        Add to review
                      </button>
                    ) : null}
                  </>
                )}
              />
            ) : null}
          </div>
        );
      },
    };
    // `reply`, `onSend` and the review callbacks close over stable props; the slot follows what it draws.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchored, detail, draft, held, writes]);

  return { slotFor, loose, reply, resolver };
}
