import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Pencil } from "lucide-react";
import { Markdown, type WorkbenchActions } from "tau";
import type { PullRequestCheck, PullRequestComment, PullRequestDetail, PullRequestReviewer, PullRequestThread, ReviewCommentChip } from "./protocol.js";
import { checksRollup, checksSummary, commentChip, relativeTime } from "./pull-request-logic.js";
import { ChecksList, CommentCard, MarkdownEditor, RollupIcon } from "./pull-request-parts.js";

/** Comments shown at once before "Show older". */
const WINDOW = 10;

const VERDICT_TITLES: Record<PullRequestReviewer["verdict"], string> = {
  approved: "Approved",
  "changes-requested": "Changes requested",
  commented: "Commented",
  dismissed: "Dismissed",
  pending: "Review requested",
};

interface Entry {
  comment: PullRequestComment;
  thread?: PullRequestThread;
}

function Section({ title, aside, defaultOpen = true, children }: { title: string; aside?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="pr-section">
      <header>
        <button className="pr-section-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {title}
        </button>
        <span className="spacer" />
        {aside}
      </header>
      {open ? <div className="pr-section-body">{children}</div> : null}
    </section>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pr-group">
      <button className="pr-group-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {label}
      </button>
      {open ? children : null}
    </div>
  );
}

/**
 * The request at a glance, in T3 Code's order: reviewers and labels, the
 * description, the checks, then every comment — active ones windowed, bots
 * and finished conversations folded away.
 */
export function PullRequestSummary({ detail, checks, threads, threadsError, actions, onSend, onSaveBody, onRetry, onOpenPath }: {
  detail: PullRequestDetail;
  checks: readonly PullRequestCheck[];
  threads: readonly PullRequestThread[];
  threadsError?: string;
  actions: WorkbenchActions;
  onSend(chip: ReviewCommentChip): void;
  onSaveBody(body: string): Promise<void>;
  onRetry(): void;
  onOpenPath(path: string): void;
}) {
  const [editingBody, setEditingBody] = useState(false);
  const [newestFirst, setNewestFirst] = useState(true);
  const [shown, setShown] = useState(WINDOW);
  const rollup = checksRollup(checks);

  const { active, bots, finished } = useMemo(() => {
    const entries: Entry[] = [
      ...detail.comments.map((comment) => ({ comment })),
      ...threads.flatMap((thread) => thread.comments.map((comment) => ({ comment, thread }))),
    ].sort((left, right) => left.comment.createdAt.localeCompare(right.comment.createdAt));
    const done = (entry: Entry) => entry.thread?.resolved === true || entry.comment.verdict === "dismissed";
    return {
      finished: entries.filter(done),
      bots: entries.filter((entry) => !done(entry) && entry.comment.author.bot),
      active: entries.filter((entry) => !done(entry) && !entry.comment.author.bot),
    };
  }, [detail.comments, threads]);
  const ordered = newestFirst ? [...active].reverse() : active;
  const total = active.length + bots.length + finished.length;

  const card = ({ comment, thread }: Entry) => (
    <CommentCard
      key={comment.id}
      comment={comment}
      actions={actions}
      {...(thread ? { where: `${thread.path}${thread.line !== undefined ? `:${thread.line}` : ""}`, outdated: thread.outdated, onOpenWhere: () => onOpenPath(thread.path) } : {})}
      onSend={() => onSend(commentChip(detail, comment, thread))}
    />
  );

  return (
    <div className="pr-summary">
      <dl className="pr-meta-grid">
        <dt>Reviewers</dt>
        <dd>
          {detail.reviewers.length === 0 ? <span className="pr-none">None</span> : detail.reviewers.map((reviewer) => (
            <span key={reviewer.login} className={`pr-reviewer verdict-${reviewer.verdict}`} title={`${reviewer.login} — ${VERDICT_TITLES[reviewer.verdict]}`}>
              <i aria-hidden="true" />{reviewer.team ? `@${reviewer.login}` : reviewer.login}
              <span className="pr-sr"> — {VERDICT_TITLES[reviewer.verdict]}</span>
            </span>
          ))}
        </dd>
        <dt>Labels</dt>
        <dd>
          {detail.labels.length === 0 ? <span className="pr-none">None</span> : detail.labels.map((label) => (
            <span key={label.name} className="pr-label">
              {/* The host's own label colour is data, drawn as a dot only. */}
              <i aria-hidden="true" style={label.color ? { background: `#${label.color}` } : undefined} />{label.name}
            </span>
          ))}
        </dd>
      </dl>

      <Section
        title="Description"
        aside={editingBody ? null : <button className="icon-button compact" aria-label="Edit description" title="Edit description" onClick={() => setEditingBody(true)}><Pencil size={12} /></button>}
      >
        {editingBody
          ? <MarkdownEditor label="Description" initial={detail.body} allowEmpty onSave={async (body) => { await onSaveBody(body); setEditingBody(false); }} onCancel={() => setEditingBody(false)} />
          : detail.body.trim() ? <div className="pr-comment-body"><Markdown>{detail.body}</Markdown></div> : <p className="pr-empty"><em>No description provided.</em></p>}
      </Section>

      <Section title="Checks" defaultOpen={rollup === "failing"} aside={<span className="pr-section-note">{rollup ? <RollupIcon rollup={rollup} /> : null}{checksSummary(checks)}</span>}>
        <ChecksList checks={checks} actions={actions} />
      </Section>

      <Section
        title={`Comments (${total})`}
        aside={<button className="text-button" onClick={() => setNewestFirst(!newestFirst)}>{newestFirst ? "Newest first" : "Oldest first"}</button>}
      >
        {threadsError ? (
          <div className="pr-unavailable compact" role="alert">
            <strong>Could not load the conversations on the code</strong>
            <p>{threadsError}</p>
            <button className="mini-button" onClick={onRetry}>Retry</button>
          </div>
        ) : null}
        {total === 0 ? <p className="pr-empty">No comments yet.</p> : null}
        {ordered.slice(0, shown).map(card)}
        {ordered.length > shown ? (
          <button className="text-button pr-more" onClick={() => setShown(shown + WINDOW)}>Show {Math.min(WINDOW, ordered.length - shown)} more comments ({ordered.length - shown} hidden)</button>
        ) : shown > WINDOW ? (
          <button className="text-button pr-more" onClick={() => setShown(WINDOW)}>Show only {WINDOW} comments</button>
        ) : null}
        {bots.length > 0 ? (
          <Group label={`${bots.length} bot ${bots.length === 1 ? "comment" : "comments"} · latest ${relativeTime(bots.at(-1)!.comment.createdAt)}`}>
            {bots.map(card)}
          </Group>
        ) : null}
        {finished.length > 0 ? (
          <Group label={`${finished.length} resolved or dismissed ${finished.length === 1 ? "comment" : "comments"}`}>
            {finished.map(card)}
          </Group>
        ) : null}
      </Section>
    </div>
  );
}
