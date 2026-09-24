import { hostTopicKey, type HostPushEvent, type HostSubscription } from "../shared/host-transport.js";

/**
 * Who a push is for. `undefined` is every client: the index, run state,
 * catalogs, questions, delivery outcomes and anything else a client needs
 * whatever it shows. A thread scope is the stream of one thread (its
 * messages, tools, notices and details), which only a client showing that
 * thread applies; a topic scope is an extension event published with a topic.
 */
export type HostPushScope = `thread:${string}` | `topic:${string}` | undefined;

const threadScope = (sessionId: string): HostPushScope => `thread:${sessionId}`;

export function hostPushScope(event: HostPushEvent): HostPushScope {
  switch (event.type) {
    case "assistant-start":
    case "assistant-delta":
    case "assistant-thinking":
    case "assistant-end":
    case "assistant-anchor":
    case "assistant-end-delta":
    case "user-message":
    case "tool-start":
    case "tool-update":
    case "tool-end":
    case "tool-update-delta":
    case "tool-end-delta":
    case "queue":
    case "notice":
      return threadScope(event.sessionId);
    case "error":
    case "event-log":
      return event.sessionId === undefined ? undefined : threadScope(event.sessionId);
    case "thread-detail-compact":
      return threadScope(event.update.detail.sessionId);
    case "host-update":
      if (event.update.type === "thread-detail") return threadScope(event.update.detail.sessionId);
      if (event.update.type === "transcript-page") return threadScope(event.update.page.sessionId);
      return undefined;
    case "extension-event":
      return event.topic === undefined ? undefined : `topic:${hostTopicKey(event.extensionId, event.topic)}`;
    default:
      return undefined;
  }
}

/** The new-thread request a detail answers, which names the thread it created. */
function answeredRequest(event: HostPushEvent): string | undefined {
  if (event.type === "thread-detail-compact") return event.update.detail.requestId;
  if (event.type === "host-update" && event.update.type === "thread-detail") return event.update.detail.requestId;
  return undefined;
}

/** Threads a filter keeps after their request is gone, until the client lists them itself. */
const MAX_PINNED = 8;

/**
 * The scopes one connection receives; a connection without a filter receives
 * every push. A thread created for a request the client awaits is pinned
 * when its first detail passes: the client learns the thread's id from that
 * detail and lists it later, and nothing of the thread is lost in between.
 */
export class HostPushFilter {
  private readonly threads: ReadonlySet<string>;
  private readonly topics: ReadonlySet<string>;
  private readonly requests: ReadonlySet<string>;
  private pinned: string[];

  constructor(subscription: HostSubscription, before?: HostPushFilter) {
    this.threads = new Set(subscription.threads);
    this.topics = new Set(subscription.topics);
    this.requests = new Set(subscription.requests ?? []);
    this.pinned = (before?.pinned ?? []).filter((id) => !this.threads.has(id));
  }

  /** Whether this push goes to the connection; a detail answering an awaited request pins its thread. */
  admits(event: HostPushEvent, scope: HostPushScope = hostPushScope(event)): boolean {
    if (scope === undefined) return true;
    if (scope.startsWith("topic:")) return this.topics.has(scope.slice("topic:".length));
    const id = scope.slice("thread:".length);
    if (this.threads.has(id) || this.pinned.includes(id)) return true;
    const request = answeredRequest(event);
    if (request === undefined || !this.requests.has(request)) return false;
    this.pinned = [...this.pinned, id].slice(-MAX_PINNED);
    return true;
  }

  /** Whether a push of this scope may have gone to the connection; for pushes it can no longer look at. */
  mayAdmit(scope: HostPushScope): boolean {
    if (scope === undefined) return true;
    if (scope.startsWith("topic:")) return this.topics.has(scope.slice("topic:".length));
    const id = scope.slice("thread:".length);
    return this.threads.has(id) || this.pinned.includes(id) || this.requests.size > 0;
  }

  /** Thread ids this filter lets through that `before` did not; none when `before` let everything through. */
  addedThreads(before: HostPushFilter | undefined): string[] {
    if (!before) return [];
    return [...this.threads].filter((id) => !before.threads.has(id) && !before.pinned.includes(id));
  }
}
