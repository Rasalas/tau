import { useEffect, useSyncExternalStore } from "react";
import { GitMerge, GitPullRequestArrow, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import { tooltipProps, useThreadStore, type UiSession } from "tau";
import { checksLabel, requestShort, requestStateLabel, type RowRequests } from "./requests.js";
import { providerInfo } from "./protocol.js";
import type { ThreadLinkRows } from "./thread-links-store.js";

type BadgeState = "open" | "draft" | "merged" | "closed";

/** T3 Code's glyphs; the colour comes from the state class. */
const ICON = { open: GitPullRequestArrow, draft: GitPullRequestDraft, merged: GitMerge, closed: GitPullRequestClosed } as const;

interface BadgeEntry {
  /** "PR #7", "MR !12". */
  label: string;
  number: number;
  state: BadgeState;
  title?: string;
  checks?: string;
}

/** Several requests read as the one most alive: any open, else a draft, else merged, else closed. */
export function aggregateState(states: readonly BadgeState[]): BadgeState {
  for (const state of ["open", "draft", "merged", "closed"] as const) if (states.includes(state)) return state;
  return "open";
}

const newestByCheckout = new WeakMap<readonly UiSession[], Map<string, string>>();

/**
 * The thread a checkout's request belongs to: the checkout's most recently
 * active one. Every thread of a checkout reads the same branch, so older
 * threads there may have worked on another branch and do not get its request.
 */
function newestInCheckout(threads: readonly UiSession[], projectPath: string): string | undefined {
  let newest = newestByCheckout.get(threads);
  if (!newest) {
    const times = new Map<string, number>();
    newest = new Map();
    for (const thread of threads) {
      if (thread.parentThreadId || thread.messageCount === 0) continue;
      if ((times.get(thread.projectPath) ?? -Infinity) >= thread.modifiedAt) continue;
      times.set(thread.projectPath, thread.modifiedAt);
      newest.set(thread.projectPath, thread.id);
    }
    newestByCheckout.set(threads, newest);
  }
  return newest.get(projectPath);
}

/**
 * The requests of a thread on its rail row, T3 Code's way: the state's glyph
 * and the number, or the glyph and "+N" for several, the list in the tooltip.
 * A row shows the requests linked to its thread, and its checkout's branch
 * request only on that checkout's newest thread.
 */
export function createRequestBadge(rows: RowRequests, links: ThreadLinkRows) {
  return function RequestBadge({ session }: { session: UiSession }) {
    const store = useThreadStore();
    const workspace = session.projectPath;
    const own = useSyncExternalStore(store.subscribe, () => newestInCheckout(store.getSnapshot().threads, workspace) === session.id);
    // A row without a branch label is no Git checkout, or a detached one.
    const tracked = Boolean(session.projectLabel) && own;
    useEffect(() => { if (tracked) rows.ensure(workspace); }, [tracked, workspace, session.projectLabel]);
    useEffect(() => { links.ensure(session.id); }, [session.id]);
    const request = useSyncExternalStore(rows.subscribe, () => tracked ? rows.get(workspace) : undefined);
    const linked = useSyncExternalStore(links.subscribe, () => links.get(session.id));

    const entries: BadgeEntry[] = [];
    if (request) {
      const checks = checksLabel(request.checks);
      entries.push({ label: `${requestShort(request)} #${request.number}`, number: request.number, state: requestStateLabel(request) as BadgeState, title: request.title, ...(checks ? { checks } : {}) });
    }
    for (const link of linked) {
      if (request && link.url === request.url) continue;
      const state: BadgeState = link.state === "open" || !link.state ? (link.draft ? "draft" : "open") : link.state;
      entries.push({ label: `${providerInfo(link.service).short} #${link.number}`, number: link.number, state, ...(link.title ? { title: link.title } : {}) });
    }
    const first = entries[0];
    if (!first) return null;

    const line = (entry: BadgeEntry) => [`${entry.label} · ${entry.state}${entry.checks ? ` · checks ${entry.checks}` : ""}`, entry.title].filter(Boolean).join(": ");
    const single = entries.length === 1;
    const state = single ? first.state : aggregateState(entries.map((entry) => entry.state));
    const Icon = ICON[state];
    const label = single
      ? `${first.label} ${first.state}${first.checks ? `, checks ${first.checks}` : ""}${request ? "" : ", linked"}`
      : `${entries.length} requests, ${state}: ${entries.map((entry) => `${entry.label} ${entry.state}`).join(", ")}`;
    return (
      <span className={`request-badge state-${state}`} role="img" aria-label={label} {...tooltipProps(entries.map(line).join("\n"), { variant: "lines" })}>
        <Icon size={12} aria-hidden="true" />
        {single ? first.number : `+${entries.length}`}
      </span>
    );
  };
}
