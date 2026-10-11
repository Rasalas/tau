/**
 * The one link to a thread: `tau://thread?thread=<id>`. The id is the reference
 * and the reader's client draws the thread's current title, so a rename reaches
 * every message that links it. `host=<id>` names the paired host when the link
 * leaves the app (a push, a widget); inside a transcript it is left out.
 */
export const THREAD_LINK_ORIGIN = "tau://thread";

export interface ThreadLinkTarget {
  threadId: string;
  hostId?: string;
}

/** The thread a `tau://thread` link names, or `undefined` for any other URL. */
export function parseThreadLink(href: string): ThreadLinkTarget | undefined {
  if (!/^tau:\/\/thread(?:[?/#]|$)/iu.test(href)) return undefined;
  let parsed: URL;
  try { parsed = new URL(href); } catch { return undefined; }
  const threadId = parsed.searchParams.get("thread")?.trim();
  if (!threadId) return undefined;
  const hostId = parsed.searchParams.get("host")?.trim();
  return { threadId, ...(hostId ? { hostId } : {}) };
}

/** `[title](tau://thread?thread=<id>)`, the label cleaned so it survives Markdown. */
export function formatThreadLink(threadId: string, title: string, hostId?: string): string {
  const label = title.replace(/[[\]\\\r\n]/gu, " ").replace(/\s+/gu, " ").trim() || threadId;
  const query = new URLSearchParams(hostId ? { host: hostId, thread: threadId } : { thread: threadId });
  return `[${label}](${THREAD_LINK_ORIGIN}?${query.toString()})`;
}
