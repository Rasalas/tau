import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import { tooltipProps } from "tau";

export type RequestState = "open" | "draft" | "merged" | "closed";

const ICONS = { open: GitPullRequest, draft: GitPullRequestDraft, merged: GitMerge, closed: GitPullRequestClosed } as const;
export const REQUEST_STATE_NAMES: Record<RequestState, string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" };

/** A request's state as the list's glyph, coloured by `.pr-glyph`; the name is its label and tooltip. */
export function RequestStateIcon({ state, size = 13, className = "" }: { state: RequestState; size?: number; className?: string }) {
  const Icon = ICONS[state];
  const name = REQUEST_STATE_NAMES[state];
  return (
    <span className={`pr-state-icon pr-glyph ${state} ${className}`.trim()} role="img" aria-label={name} {...tooltipProps(name)}>
      <Icon size={size} aria-hidden="true" />
    </span>
  );
}
