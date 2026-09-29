import { useEffect, useSyncExternalStore, type ComponentType } from "react";
import { GitMerge, GitPullRequestArrow, GitPullRequestClosed, GitPullRequestDraft, Layers } from "lucide-react";
import { tooltipProps, useThreadStore, type UiSession } from "tau";
import { checksLabel, requestShort, requestStateLabel, type RowRequests } from "./requests.js";
import { providerInfo, type RequestService, type ThreadCardSectionProps } from "./protocol.js";
import { openPullRequest } from "./pull-request-open.js";
import type { ThreadLinkRows } from "./thread-links-store.js";

type BadgeState = "open" | "draft" | "merged" | "closed";

/** The state glyphs; the colour comes from the state class. */
const ICON = { open: GitPullRequestArrow, draft: GitPullRequestDraft, merged: GitMerge, closed: GitPullRequestClosed } as const;

interface BadgeEntry {
  /** "PR #7", "MR !12". */
  label: string;
  url: string;
  service: RequestService;
  number: number;
  state: BadgeState;
  title?: string;
  checks?: string;
  stack?: { number: number; size: number };
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
 * The requests of a thread on its rail row: the state's glyph
 * and the number, or the glyph and "+N" for several, the list in the tooltip.
 * A thread on a stack shows the layers glyph and the stack's size.
 * A row shows the requests linked to its thread, and its checkout's branch
 * request only on that checkout's newest thread.
 */
/** A thread's requests: its checkout's branch request first, then the ones it links. */
function useThreadRequests(rows: RowRequests, links: ThreadLinkRows, session: UiSession): { entries: BadgeEntry[]; branch: boolean } {
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
    entries.push({ label: `${requestShort(request)} #${request.number}`, url: request.url, service: request.provider, number: request.number, state: requestStateLabel(request) as BadgeState, title: request.title, ...(checks ? { checks } : {}) });
  }
  for (const link of linked) {
    if (request && link.url === request.url) continue;
    const state: BadgeState = link.state === "open" || !link.state ? (link.draft ? "draft" : "open") : link.state;
    entries.push({ label: `${providerInfo(link.service).short} #${link.number}`, url: link.url, service: link.service, number: link.number, state, ...(link.title ? { title: link.title } : {}), ...(link.stack ? { stack: link.stack } : {}) });
  }
  return { entries, branch: Boolean(request) };
}

/** The card lists a thread's requests newest first: a repository numbers them in the order they were opened. */
export function newestFirst<T extends { number: number }>(entries: readonly T[]): T[] {
  return entries.slice().sort((left, right) => right.number - left.number);
}

export function createRequestBadge(rows: RowRequests, links: ThreadLinkRows) {
  return function RequestBadge({ session }: { session: UiSession }) {
    const { entries, branch: request } = useThreadRequests(rows, links, session);
    const first = entries[0];
    if (!first) return null;

    const line = (entry: BadgeEntry) => [`${entry.label} · ${entry.state}${entry.stack ? ` · stack #${entry.stack.number} of ${entry.stack.size}` : ""}${entry.checks ? ` · checks ${entry.checks}` : ""}`, entry.title].filter(Boolean).join(": ");
    const single = entries.length === 1;
    const state = single ? first.state : aggregateState(entries.map((entry) => entry.state));
    // A thread that works on a stack shows the stack: the layers glyph and its size.
    const stack = entries.find((entry) => entry.stack)?.stack;
    const Icon = stack ? Layers : ICON[state];
    const label = stack
      ? `Stack of ${stack.size} requests, ${state}: ${entries.map((entry) => `${entry.label} ${entry.state}`).join(", ")}`
      : single
        ? `${first.label} ${first.state}${first.checks ? `, checks ${first.checks}` : ""}${request ? "" : ", linked"}`
        : `${entries.length} requests, ${state}: ${entries.map((entry) => `${entry.label} ${entry.state}`).join(", ")}`;
    return (
      <span className={`request-badge state-${state}`} role="img" aria-label={label} {...tooltipProps(entries.map(line).join("\n"), { variant: "lines" })}>
        <Icon size={12} aria-hidden="true" />
        {stack ? stack.size : single ? first.number : `+${entries.length}`}
      </span>
    );
  };
}

/**
 * The thread's requests on its rail row's hover card: the
 * state's glyph in its colour, the number and the title, newest first. A
 * line opens the request's view on the stage.
 */
export function createRequestCardSection(rows: RowRequests, links: ThreadLinkRows): ComponentType<ThreadCardSectionProps> {
  return function RequestCardSection({ session, external, actions, Row }: ThreadCardSectionProps) {
    // Another machine's thread: its requests are that machine's to read.
    if (external) return null;
    return <RequestCardList session={session} actions={actions} Row={Row} rows={rows} links={links} />;
  };
}

function RequestCardList({ session, actions, Row, rows, links }: Pick<ThreadCardSectionProps, "session" | "actions" | "Row"> & { rows: RowRequests; links: ThreadLinkRows }) {
  const { entries } = useThreadRequests(rows, links, session);
  if (entries.length === 0) return null;
  const open = (entry: BadgeEntry) => openPullRequest(actions, { url: entry.url, number: entry.number, provider: entry.service }, session.projectPath);
  return (
    <div className="request-card-list" role="list" aria-label="Pull requests">
      {newestFirst(entries).map((entry) => {
        const Icon = ICON[entry.state];
        return (
          <div key={entry.url} role="listitem" className={`request-card-line state-${entry.state}`}>
            <Row icon={<Icon size={12} />} label={`${entry.label}, ${entry.state}${entry.title ? `: ${entry.title}` : ""}`} onClick={() => open(entry)}>
              <b>#{entry.number}</b> {entry.title ?? entry.url}
            </Row>
          </div>
        );
      })}
    </div>
  );
}
