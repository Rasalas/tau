import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ArrowLeft, ArrowUpRight, Copy, Ellipsis, Eye, EyeOff, Link, Link2Off, Share2 } from "lucide-react";
import { Empty, Sheet, Spinner, errorMessage, tooltipProps, useCommandAllowed, type WorkbenchActions } from "tau";
import { readLinkInput } from "./link-dialog.js";
import type { PullRequestWatchFeed } from "./pr-watch-client.js";
import type { PullRequestWatch } from "./pr-watch-protocol.js";
import { REVIEW_HOST_EXTENSION_ID, providerInfo, requestNumber, type PullRequestListEntry, type ThreadPullRequestLink } from "./protocol.js";
import type { PullRequestClient } from "./pull-request-client.js";
import { openPullRequest } from "./pull-request-open.js";
import { RequestStateIcon, type RequestState } from "./request-state-icon.js";
import { copyPullRequestLink, sharePullRequestLink } from "./share-link.js";
import type { ThreadLinkRows } from "./thread-links-store.js";

export interface ThreadLinkSheetParts {
  client: PullRequestClient;
  links: ThreadLinkRows;
  watches: PullRequestWatchFeed;
}

export interface ThreadLinkTarget { threadId: string; cwd?: string }

const LIST_LIMIT = 50;
const requestState = (link: Pick<ThreadPullRequestLink, "state" | "draft">): RequestState => link.state === "merged" || link.state === "closed" ? link.state : link.draft ? "draft" : "open";
const label = (link: Pick<ThreadPullRequestLink, "service" | "number">) => `${providerInfo(link.service).short} ${requestNumber(link.service, link.number)}`;

function LinkedRow({ link, threadId, cwd, actions, watch, feed, client, close, onChanged }: {
  link: ThreadPullRequestLink;
  client: PullRequestClient;
  threadId: string;
  cwd?: string | undefined;
  actions: WorkbenchActions;
  watch?: PullRequestWatch | undefined;
  feed: PullRequestWatchFeed;
  close(): void;
  onChanged(): Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mayWatch = useCommandAllowed(REVIEW_HOST_EXTENSION_ID, "watch-start");
  const mayUnlink = useCommandAllowed(REVIEW_HOST_EXTENSION_ID, "unlink-pr");
  const state = requestState(link);
  const name = `${label(link)} ${link.title ?? link.repo}`;
  const watching = Boolean(watch && watch.status !== "ended");
  const watchable = link.service === "github" && (watching || state === "open" || state === "draft");
  const watchReason = !mayWatch ? "This device is read-only." : !watchable ? (link.service === "github" ? "This pull request is closed." : "Watching works for GitHub pull requests.") : undefined;
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try { await task(); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  };
  const open = () => { close(); openPullRequest(actions, { url: link.url, number: link.number, provider: link.service }, cwd); };
  const unlink = () => void run(async () => {
    await client.unlink(threadId, link.url);
    await onChanged();
  });
  return <li className={`thread-sheet-item state-${state}`}>
    <div className="thread-sheet-row">
      <button type="button" className="thread-sheet-main" aria-label={`Open ${name}, ${state}`} onClick={open}>
        <RequestStateIcon state={state} size={16} />
        <span className="thread-sheet-lines">
          <span className="thread-sheet-title"><b>{requestNumber(link.service, link.number)}</b> {link.title ?? link.repo}</span>
          <span className="thread-sheet-meta">{[link.repo, link.headRef].filter(Boolean).join(" · ")}</span>
        </span>
        {watching ? <Eye size={14} className="thread-sheet-watching" aria-label="Watching" {...tooltipProps("Watching")} /> : null}
      </button>
      <button type="button" className="thread-sheet-more" aria-label={`Actions for ${label(link)}`} aria-expanded={expanded} {...tooltipProps("Actions")} onClick={() => setExpanded(!expanded)}><Ellipsis size={18} aria-hidden="true" /></button>
    </div>
    {expanded ? <div className="thread-sheet-actions" role="group" aria-label={`Actions for ${label(link)}`}>
      <button type="button" aria-label={watching ? `Stop watching ${label(link)}` : `Watch ${label(link)}`} {...tooltipProps(watchReason ?? (watching ? "Stop watching" : "Watch for changes"))}
        disabled={busy || Boolean(watchReason)} onClick={() => void run(() => feed.change(watching ? "watch-stop" : "watch-start", threadId, link.url))}>{watching ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}</button>
      <button type="button" aria-label={`Open ${label(link)}`} {...tooltipProps("Open")} onClick={open}><ArrowUpRight size={18} aria-hidden="true" /></button>
      <button type="button" aria-label={`Copy link to ${label(link)}`} {...tooltipProps("Copy link")} onClick={() => void copyPullRequestLink(link.url, actions)}><Copy size={18} aria-hidden="true" /></button>
      <button type="button" aria-label={`Share ${label(link)}`} {...tooltipProps("Share")} onClick={() => void sharePullRequestLink({ url: link.url, title: `${label(link)} ${link.title ?? link.repo}` }, actions)}><Share2 size={18} aria-hidden="true" /></button>
      <button type="button" className="destructive" aria-label={`Unlink ${label(link)}`} {...tooltipProps(mayUnlink ? "Unlink from this thread" : "This device is read-only.")} disabled={busy || !mayUnlink} onClick={unlink}><Link2Off size={18} aria-hidden="true" /></button>
    </div> : null}
    {error ? <p className="pr-error" role="alert">{error}</p> : null}
  </li>;
}

/** Paste a URL or number, or pick from the project's open requests; either links it to the thread. */
function LinkView({ target, parts, actions, back, linked }: { target: ThreadLinkTarget; parts: ThreadLinkSheetParts; actions: WorkbenchActions; back(): void; linked: readonly ThreadPullRequestLink[] }) {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const [list, setList] = useState<{ status: "loading" } | { status: "ready"; entries: PullRequestListEntry[] } | { status: "error"; message: string }>({ status: "loading" });
  useEffect(() => {
    if (!target.cwd) { setList({ status: "ready", entries: [] }); return undefined; }
    let live = true;
    parts.client.list({ workspace: target.cwd, state: "open", limit: LIST_LIMIT }).then(
      (result) => { if (live) setList({ status: "ready", entries: result.entries }); },
      (error: unknown) => { if (live) setList({ status: "error", message: errorMessage(error) }); },
    );
    return () => { live = false; };
  }, [parts.client, target.cwd]);
  const typed = readLinkInput(query);
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const entries = useMemo(() => list.status !== "ready" ? [] : list.entries.filter((entry) => {
    const terms = [`#${entry.ref.number}`, String(entry.ref.number), entry.title, entry.headRef, entry.author?.login].filter(Boolean).join(" ").toLowerCase();
    return words.every((word) => terms.includes(word));
  }), [list, query]);
  const link = async (reference: string) => {
    setPending(reference);
    setFailure(undefined);
    try {
      const result = await parts.client.link(target.threadId, reference, target.cwd);
      void parts.links.load(target.threadId);
      actions.notify(result.alreadyLinked ? `${requestNumber(result.link.service, result.link.number)} is already linked to this thread.` : `Linked ${requestNumber(result.link.service, result.link.number)} to this thread.`);
      back();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setPending(undefined);
    }
  };
  const canLinkTyped = typed !== undefined && typed.kind !== "invalid";
  return <div className="thread-sheet-link">
    <div className="thread-sheet-link-head">
      <button type="button" className="thread-sheet-icon" aria-label="Back to pull requests" {...tooltipProps("Back")} onClick={back}><ArrowLeft size={18} aria-hidden="true" /></button>
      <input
        aria-label="Pull request URL or number"
        placeholder="Search, or paste a URL or #123"
        inputMode="url"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        value={query}
        disabled={Boolean(pending)}
        onChange={(event) => { setQuery(event.target.value); setFailure(undefined); }}
        onKeyDown={(event) => { if (event.key === "Enter" && canLinkTyped) { event.preventDefault(); void link(query.trim()); } }}
      />
    </div>
    {failure ? <p className="pr-error" role="alert">{failure}</p> : null}
    <ul className="thread-sheet-list" aria-label="Open pull requests">
      {canLinkTyped ? <li><button type="button" className="thread-sheet-main" disabled={Boolean(pending)} onClick={() => void link(query.trim())}>
        <Link size={16} aria-hidden="true" /><span className="thread-sheet-lines"><span className="thread-sheet-title">Link {typed.label}</span></span>
      </button></li> : null}
      {entries.map((entry) => {
        const already = linked.some((existing) => existing.url === entry.ref.url);
        const name = `${label(entry.ref)} ${entry.title}`;
        return <li key={entry.ref.url}><button type="button" className="thread-sheet-main" aria-label={already ? `${name}, already linked` : `Link ${name}`} disabled={already || Boolean(pending)} onClick={() => void link(entry.ref.url)}>
          <RequestStateIcon state={entry.draft ? "draft" : "open"} size={16} />
          <span className="thread-sheet-lines">
            <span className="thread-sheet-title"><b>{requestNumber(entry.ref.service, entry.ref.number)}</b> {entry.title}</span>
            <span className="thread-sheet-meta">{[entry.headRef, entry.author?.login, already ? "Linked" : undefined].filter(Boolean).join(" · ")}</span>
          </span>
        </button></li>;
      })}
    </ul>
    {list.status === "loading" ? <Spinner size="sm" label="Loading open pull requests" /> : null}
    {list.status === "error" ? <p className="thread-sheet-note" role="status">{list.message} Paste a pull request URL or enter #123.</p> : null}
    {list.status === "ready" && !entries.length && !canLinkTyped ? <p className="thread-sheet-note" role="status">{words.length ? "No open pull request matches. Paste its URL or enter #123." : "No open pull requests in this project. Paste a URL or enter #123."}</p> : null}
  </div>;
}

export default function ThreadLinkSheet({ target, parts, actions, onClose }: { target: ThreadLinkTarget; parts: ThreadLinkSheetParts; actions: WorkbenchActions; onClose(): void }) {
  const { threadId } = target;
  const [view, setView] = useState<"list" | "link">("list");
  const links = useSyncExternalStore(parts.links.subscribe, () => parts.links.get(threadId));
  const loaded = useSyncExternalStore(parts.links.subscribe, () => parts.links.has(threadId));
  const feed = useSyncExternalStore(parts.watches.subscribe, parts.watches.get);
  const mayLink = useCommandAllowed(REVIEW_HOST_EXTENSION_ID, "link-pr");
  useEffect(() => {
    const stop = parts.links.watch(threadId);
    void parts.links.load(threadId, true);
    return stop;
  }, [parts.links, threadId]);
  return <Sheet title="Pull requests" className="thread-link-sheet" onClose={onClose}>
    {view === "link" ? <LinkView target={target} parts={parts} actions={actions} linked={links} back={() => setView("list")} /> : <div className="thread-sheet-body">
      <button type="button" className="thread-sheet-add" disabled={!mayLink} {...tooltipProps(mayLink ? "Link a pull request to this thread" : "This device is read-only.")} onClick={() => setView("link")}><Link size={16} aria-hidden="true" />Link a pull request…</button>
      {links.length ? <ul className="thread-sheet-list" aria-label="Linked pull requests">
        {links.map((link) => <LinkedRow key={link.url} link={link} threadId={threadId} cwd={target.cwd} actions={actions} feed={parts.watches} client={parts.client}
          watch={feed.watches.find((watch) => watch.threadId === threadId && watch.ref.url === link.url)} close={onClose} onChanged={() => parts.links.load(threadId)} />)}
      </ul> : loaded ? <Empty title="No linked pull requests" description="Pull requests this thread links appear here." /> : <Spinner size="sm" label="Loading linked pull requests" />}
    </div>}
  </Sheet>;
}
