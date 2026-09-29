import { useEffect, useMemo, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, MessageSquare } from "lucide-react";
import { Dialog, Menu, errorMessage, useThreadStore, type ThreadStore, type UiSession, type WorkbenchActions } from "tau";
import type { PullRequestClient } from "./pull-request-client.js";
import type { ThreadLinkRows } from "./thread-links-store.js";

const EMPTY: readonly UiSession[] = [];
const NOTHING_TO_WATCH = () => () => undefined;

/** The window's thread index; a view drawn outside a workbench (a test) has none. */
function useThreads(): ThreadStore | undefined {
  try {
    return useThreadStore();
  } catch {
    return undefined;
  }
}

function useThreadList(store: ThreadStore | undefined): readonly UiSession[] {
  return useSyncExternalStore(store?.subscribe ?? NOTHING_TO_WATCH, () => store?.getSnapshot().threads ?? EMPTY);
}

/** The threads that link a request, read again whenever any thread's links change. */
export function useLinkedThreads(client: PullRequestClient, url: string): string[] | undefined {
  const [threads, setThreads] = useState<string[]>();
  useEffect(() => {
    let alive = true;
    const read = () => { void client.linkedThreads(url).then((next) => { if (alive) setThreads(next); }, () => undefined); };
    read();
    const stop = client.onLinksChanged(read);
    return () => { alive = false; stop(); };
  }, [client, url]);
  return threads;
}

/**
 * "Linked from 2 threads" in a request's header: the threads
 * that keep this request, archived ones included, each a click away.
 */
export function LinkedThreadsControl({ threadIds, actions }: { threadIds: readonly string[] | undefined; actions: WorkbenchActions }) {
  const store = useThreads();
  const threads = useThreadList(store);
  const [menu, setMenu] = useState(false);
  if (!threadIds || threadIds.length === 0) return null;
  const known = threadIds.map((id) => threads.find((thread) => thread.id === id) ?? { id });
  const label = `Linked from ${threadIds.length} ${threadIds.length === 1 ? "thread" : "threads"}`;
  const pick = (id: string) => {
    setMenu(false);
    const thread = threads.find((entry) => entry.id === id);
    if (thread) void actions.switchSession(thread.path);
  };
  return (
    <span className="menu-anchor">
      <button className="pr-stack-button" aria-label={label} title={label} aria-expanded={menu} onClick={() => setMenu(!menu)}>
        <MessageSquare size={12} aria-hidden="true" /> {threadIds.length}
      </button>
      {menu ? (
        <Menu
          heading={label}
          items={known.map((thread) => "title" in thread
            ? { id: thread.id, label: thread.title || "Untitled thread", description: thread.projectName }
            : { id: thread.id, label: "A thread this window does not list", description: thread.id.slice(0, 8), disabled: true })}
          onSelect={pick}
          onClose={() => setMenu(false)}
        />
      ) : null}
    </span>
  );
}

/**
 * "Link to thread": search the threads by title or project and
 * link the request to the one picked. A thread that already links it is
 * marked and cannot be picked twice.
 */
export function ThreadPicker({ url, linkedThreads, client, rows, onClose, notify }: {
  url: string;
  linkedThreads: readonly string[];
  client: PullRequestClient;
  rows: ThreadLinkRows;
  onClose(): void;
  notify(message: string): void;
}) {
  const store = useThreads();
  const threads = useThreadList(store);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();
  const words = query.trim().toLowerCase();
  const candidates = useMemo(() => threads
    .filter((thread) => !thread.parentThreadId && `${thread.title} ${thread.projectName}`.toLowerCase().includes(words))
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(0, 50), [threads, words]);

  const pick = async (thread: UiSession) => {
    if (pending || linkedThreads.includes(thread.id)) return;
    setPending(true);
    setFailure(undefined);
    try {
      const result = await client.link(thread.id, url, thread.projectPath);
      void rows.load(thread.id);
      notify(result.alreadyLinked ? `#${result.link.number} is already linked to “${thread.title}”.` : `Linked #${result.link.number} to “${thread.title}”.`);
      onClose();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setPending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setCursor((at) => Math.min(candidates.length - 1, at + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setCursor((at) => Math.max(0, at - 1)); }
    else if (event.key === "Enter") { event.preventDefault(); const thread = candidates[cursor]; if (thread) void pick(thread); }
  };

  return createPortal(
    <Dialog className="pr-link-dialog pr-thread-picker" label="Link to a thread" onClose={() => { if (!pending) onClose(); }}>
      <header>
        <h2>Link to thread</h2>
        <p>The thread keeps this request beside it, whichever project the thread works in.</p>
      </header>
      <input autoFocus aria-label="Search threads or projects" placeholder="Search threads or projects…" value={query} disabled={pending}
        onChange={(event) => { setQuery(event.target.value); setCursor(0); }} onKeyDown={onKeyDown} />
      <ul className="pr-thread-list" role="listbox" aria-label="Threads">
        {candidates.length === 0 ? <li className="pr-thread-empty">No threads found.</li> : candidates.map((thread, index) => {
          const linked = linkedThreads.includes(thread.id);
          return (
            <li key={thread.id} role="option" aria-selected={index === cursor} aria-disabled={linked || pending}
              className={`${index === cursor ? "active" : ""} ${linked ? "linked" : ""}`}
              onMouseEnter={() => setCursor(index)} onClick={() => void pick(thread)}>
              <MessageSquare size={13} aria-hidden="true" />
              <span><strong>{thread.title || "Untitled thread"}</strong><small>{thread.projectName}</small></span>
              {linked ? <em><Check size={11} aria-hidden="true" /> Linked</em> : null}
            </li>
          );
        })}
      </ul>
      {failure ? <p className="pr-error" role="alert">{failure}</p> : null}
      <footer>
        <button disabled={pending} onClick={onClose}>Cancel</button>
      </footer>
    </Dialog>,
    document.body,
  );
}
