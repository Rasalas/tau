/**
 * The open thread, in the page's address: `?thread=<id>`. A push notification
 * or a bookmark opens a thread by it, a reload keeps it, and the browser's
 * back button returns to the thread before.
 */
export const THREAD_PARAM = "thread";

export function threadFromUrl(href: string): string | undefined {
  return new URL(href).searchParams.get(THREAD_PARAM) || undefined;
}

export function urlWithThread(href: string, threadId: string | undefined): string {
  const url = new URL(href);
  if (threadId) url.searchParams.set(THREAD_PARAM, threadId);
  else url.searchParams.delete(THREAD_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

export type ThreadUrlStep =
  | { kind: "wait" }
  | { kind: "open"; path: string }
  | { kind: "write"; threadId: string; push: boolean }
  | { kind: "none" };

/**
 * What the address and the open thread should do about each other. A thread
 * the address asks for wins until the index has it (or is known not to);
 * after that the address follows the open thread, a new entry per switch.
 */
export function threadUrlStep(input: {
  wanted?: string;
  inUrl?: string;
  activeThreadId: string;
  threads: readonly { id: string; path: string }[];
  firstWrite: boolean;
}): ThreadUrlStep {
  const { wanted, inUrl, activeThreadId, threads } = input;
  if (wanted) {
    const target = threads.find((thread) => thread.id === wanted);
    if (target) return target.id === activeThreadId ? { kind: "none" } : { kind: "open", path: target.path };
    if (threads.length === 0) return { kind: "wait" };
  }
  if (!activeThreadId || activeThreadId === inUrl) return { kind: "none" };
  return { kind: "write", threadId: activeThreadId, push: !input.firstWrite && Boolean(inUrl) };
}
