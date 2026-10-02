import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, CircleCheck, CircleX, GitCommitHorizontal, GitMerge, GitPullRequest, GitPullRequestClosed, MessageSquare } from "lucide-react";
import { Markdown, type WorkbenchActions } from "tau";
import { providerInfo, type PullRequestDetail } from "./protocol.js";
import { buildTimeline, relativeTime, shortNoun, type TimelineItem } from "./pull-request-logic.js";
import { verdictWord } from "./pull-request-parts.js";
import { githubHtml } from "./github-html.js";

function Conversation({ item, actions }: { item: Extract<TimelineItem, { kind: "conversation" }>; actions: WorkbenchActions }) {
  const [open, setOpen] = useState(false);
  const authors = new Set(item.comments.map((comment) => comment.author.login)).size;
  return (
    <li className={`pr-event conversation ${open ? "open" : ""}`}>
      <span className="pr-event-mark" aria-hidden="true"><MessageSquare size={12} /></span>
      <div className="pr-event-body">
        <button className="pr-event-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {item.comments.length} {item.comments.length === 1 ? "comment" : "comments"} · {authors} {authors === 1 ? "author" : "authors"} · {relativeTime(item.at)}
        </button>
        {open ? item.comments.map((comment) => (
          <article key={comment.id} className="pr-event-card">
            <p>
              <strong>{comment.author.login}</strong> {verdictWord(comment)}{" "}
              {comment.url ? <button className="pr-time" onClick={() => actions.openExternal(comment.url!)}>{relativeTime(comment.createdAt)}</button> : <span className="pr-time">{relativeTime(comment.createdAt)}</span>}
            </p>
            {comment.body.trim() ? <div className="pr-comment-body"><Markdown html={githubHtml}>{comment.body}</Markdown></div> : null}
          </article>
        )) : null}
      </div>
    </li>
  );
}

/**
 * The request's history on one rail: when it opened, each commit, each run
 * of comments folded to one row, each verdict, and how it ended.
 */
export function PullRequestTimeline({ detail, oldestFirst, actions }: { detail: PullRequestDetail; oldestFirst: boolean; actions: WorkbenchActions }) {
  const items = useMemo(() => buildTimeline(detail, oldestFirst), [detail, oldestFirst]);
  const noun = providerInfo(detail.ref.service).noun.replace(/^./u, (first) => first.toUpperCase());
  if (items.length === 0) return <p className="pr-empty pr-pad">No activity yet.</p>;
  return (
    <ol className="pr-timeline" aria-label={`${shortNoun(detail.ref.service)} #${detail.ref.number} timeline`}>
      {items.map((item) => {
        switch (item.kind) {
          case "conversation":
            return <Conversation key={item.key} item={item} actions={actions} />;
          case "commit":
            return (
              <li key={item.key} className="pr-event commit">
                <span className="pr-event-mark" aria-hidden="true"><GitCommitHorizontal size={12} /></span>
                <div className="pr-event-body">
                  <span className="pr-event-line"><span className="pr-commit-headline">{item.headline || "Untitled commit"}</span><code>{item.oid.slice(0, 7)}</code><span className="pr-time">{relativeTime(item.at)}</span></span>
                </div>
              </li>
            );
          case "verdict": {
            const approved = item.comment.verdict === "approved";
            return (
              <li key={item.key} className={`pr-event verdict verdict-${item.comment.verdict}`}>
                <span className="pr-event-mark" aria-hidden="true">{approved ? <CircleCheck size={12} /> : <CircleX size={12} />}</span>
                <div className="pr-event-body">
                  <span className="pr-event-line"><strong>{item.comment.author.login}</strong> <span className="pr-verb">{verdictWord(item.comment)}</span> <span className="pr-time">{relativeTime(item.at)}</span></span>
                  {item.comment.body.trim() ? <div className="pr-comment-body"><Markdown html={githubHtml}>{item.comment.body}</Markdown></div> : null}
                </div>
              </li>
            );
          }
          default: {
            const Icon = item.kind === "merged" ? GitMerge : item.kind === "closed" ? GitPullRequestClosed : GitPullRequest;
            const verb = item.kind === "opened" ? "opened" : item.kind;
            return (
              <li key={item.key} className={`pr-event lifecycle ${item.kind}`}>
                <span className="pr-event-mark" aria-hidden="true"><Icon size={12} /></span>
                <div className="pr-event-body">
                  <span className="pr-event-line">{noun} {verb}{item.kind === "opened" && item.author ? <> by <strong>{item.author}</strong></> : null} <span className="pr-time">{relativeTime(item.at)}</span></span>
                </div>
              </li>
            );
          }
        }
      })}
    </ol>
  );
}
