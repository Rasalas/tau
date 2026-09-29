import { useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Dialog, errorMessage, type RegionProps } from "tau";
import { parseRequestUrl } from "./pull-request-json.js";
import type { PullRequestClient } from "./pull-request-client.js";
import type { ThreadLinkRows } from "./thread-links-store.js";

interface LinkTarget {
  threadId: string;
  cwd?: string;
}

/** Which thread the link dialog is open for; a command sets it, the title-bar layer draws it. */
export class LinkDialogs {
  private open: LinkTarget | undefined;
  private readonly listeners = new Set<() => void>();

  show(target: LinkTarget): void { this.set(target); }
  close(): void { this.set(undefined); }
  getSnapshot = (): LinkTarget | undefined => this.open;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private set(open: LinkTarget | undefined): void {
    if (this.open === open) return;
    this.open = open;
    for (const listener of [...this.listeners]) listener();
  }
}

/** What an input names: a request URL, or a number in the thread's own repository. */
export function readLinkInput(value: string): { kind: "url"; label: string } | { kind: "number"; label: string } | { kind: "invalid" } | undefined {
  const typed = value.trim();
  if (!typed) return undefined;
  if (/^https?:\/\//iu.test(typed)) {
    const ref = parseRequestUrl(typed);
    return ref ? { kind: "url", label: `${ref.host}/${ref.repo} #${ref.number}` } : { kind: "invalid" };
  }
  const number = /^#?(\d+)$/u.exec(typed)?.[1];
  return number && Number(number) > 0 ? { kind: "number", label: `#${number} in this thread's repository` } : { kind: "invalid" };
}

/**
 * "Link pull request": a URL from any repository on a host the
 * project reaches, or a number in the thread's own; Enter links.
 */
function LinkPullRequestDialog({ target, client, rows, onClose, notify }: {
  target: LinkTarget;
  client: PullRequestClient;
  rows: ThreadLinkRows;
  onClose(): void;
  notify(message: string): void;
}) {
  const [reference, setReference] = useState("");
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();
  const read = readLinkInput(reference);
  const validation = !dirty ? undefined
    : !read ? "Paste a pull request URL or enter 123 / #123."
      : read.kind === "invalid" ? "Use a pull request URL, 123, or #123." : undefined;

  const submit = async () => {
    setDirty(true);
    if (!read || read.kind === "invalid" || pending) return;
    setPending(true);
    setFailure(undefined);
    try {
      const result = await client.link(target.threadId, reference.trim(), target.cwd);
      void rows.load(target.threadId);
      notify(result.alreadyLinked ? `#${result.link.number} is already linked to this thread.` : `Linked #${result.link.number} to this thread.`);
      onClose();
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog className="pr-link-dialog" label="Link pull request" onClose={() => { if (!pending) onClose(); }}>
      <header>
        <h2>Link pull request</h2>
        <p>Attach a pull request to this thread. A full URL can point at any repository on a host this project can reach.</p>
      </header>
      <input
        autoFocus
        aria-label="Pull request URL or number"
        placeholder="Pull request URL or #42"
        value={reference}
        disabled={pending}
        onChange={(event) => { setDirty(true); setReference(event.target.value); }}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submit(); } }}
      />
      {read && read.kind !== "invalid" ? <p className="pr-link-preview">{read.label}</p> : null}
      {validation ?? failure ? <p className="pr-error" role="alert">{validation ?? failure}</p> : null}
      <footer>
        <button disabled={pending} onClick={onClose}>Cancel</button>
        <button className="primary" disabled={pending || !read || read.kind === "invalid"} onClick={() => void submit()}>{pending ? "Linking…" : "Link"}</button>
      </footer>
    </Dialog>
  );
}

/** Drawn from a title-bar region, over the whole window, while a thread's dialog is open. */
export function createLinkDialogLayer(dialogs: LinkDialogs, client: PullRequestClient, rows: ThreadLinkRows) {
  return function LinkDialogLayer({ actions }: RegionProps) {
    const target = useSyncExternalStore(dialogs.subscribe, dialogs.getSnapshot, dialogs.getSnapshot);
    if (!target) return null;
    return createPortal(
      <LinkPullRequestDialog key={target.threadId} target={target} client={client} rows={rows} onClose={() => dialogs.close()} notify={(message) => actions.notify(message)} />,
      document.body,
    );
  };
}
