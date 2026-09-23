import type { ClientStorage, UiReviewRequestChecks } from "tau";
import type { RequestService, ReviewRequest, ThreadPullRequestLink } from "./protocol.js";
import { parseRequestUrl } from "./pull-request-json.js";

/** Review Kit's option "Show the pull request above the composer", on by default. */
export const STRIP_OPTION = "pull-request-strip";

export type StripState = "open" | "draft" | "merged" | "closed";

/** One request as the strip draws it, from the branch's request or a thread's link. */
export interface StripRequest {
  url: string;
  number: number;
  service: RequestService;
  host?: string;
  repo?: string;
  title?: string;
  state: StripState;
  headRef?: string;
  checks?: UiReviewRequestChecks;
  /** When the thread linked it; absent for the branch's own request. */
  linkedAt?: number;
}

const ENDED = new Set<StripState>(["merged", "closed"]);

function stateOf(state: "open" | "closed" | "merged" | undefined, draft: boolean | undefined): StripState {
  if (state === "merged" || state === "closed") return state;
  return draft ? "draft" : "open";
}

function fromBranch(request: ReviewRequest): StripRequest {
  const ref = parseRequestUrl(request.url);
  return {
    url: request.url, number: request.number, service: request.provider, state: stateOf(request.state, request.draft),
    ...(ref ? { host: ref.host, repo: ref.repo } : {}),
    ...(request.title ? { title: request.title } : {}),
    ...(request.headRef ? { headRef: request.headRef } : {}),
    ...(request.checks ? { checks: request.checks } : {}),
  };
}

function fromLink(link: ThreadPullRequestLink): StripRequest {
  return {
    url: link.url, number: link.number, service: link.service, host: link.host, repo: link.repo, state: stateOf(link.state, link.draft), linkedAt: link.linkedAt,
    ...(link.title ? { title: link.title } : {}),
    ...(link.headRef ? { headRef: link.headRef } : {}),
  };
}

/**
 * The thread's requests for the strip: the branch's own and the ones it links,
 * once each. Open and draft come before ended ones; then the branch's own,
 * then the latest link. A link that saw its request end wins over a branch
 * read that still says open, as the rail refreshes links more often.
 */
export function stripRequests(branch: ReviewRequest | undefined, links: readonly ThreadPullRequestLink[]): { primary: StripRequest; others: StripRequest[] } | undefined {
  const all = new Map<string, StripRequest>();
  if (branch) all.set(branch.url, fromBranch(branch));
  for (const link of links) {
    const known = all.get(link.url);
    const linked = fromLink(link);
    if (!known) all.set(link.url, linked);
    else all.set(link.url, { ...linked, ...known, linkedAt: link.linkedAt, ...(ENDED.has(linked.state) && !ENDED.has(known.state) ? { state: linked.state } : {}) });
  }
  const ranked = [...all.values()].sort((a, b) =>
    Number(ENDED.has(a.state)) - Number(ENDED.has(b.state))
    || Number(a.url !== branch?.url) - Number(b.url !== branch?.url)
    || (b.linkedAt ?? 0) - (a.linkedAt ?? 0));
  const [primary, ...others] = ranked;
  return primary ? { primary, others } : undefined;
}

/** What a hidden strip stays hidden for: the same request in the same state. */
export const dismissalOf = (request: Pick<StripRequest, "url" | "state">): string => `${request.state} ${request.url}`;

const KEY = "tau.review.pull-request-strip.hidden";
/** Threads remembered at most; the oldest hide is forgotten first. */
const LIMIT = 200;

/** Per thread, the request and state the user hid the strip for, in this client's storage. */
export class StripDismissals {
  private hidden: Map<string, string>;
  private version = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: () => ClientStorage | undefined) {
    this.hidden = new Map();
    try {
      for (const [thread, value] of Object.entries(JSON.parse(storage()?.get(KEY) ?? "{}") as Record<string, unknown>)) {
        if (typeof value === "string") this.hidden.set(thread, value);
      }
    } catch {
      // Nothing hidden when the store cannot be read.
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getVersion = (): number => this.version;

  isHidden(threadId: string, request: Pick<StripRequest, "url" | "state">): boolean {
    return this.hidden.get(threadId) === dismissalOf(request);
  }

  hide(threadId: string, request: Pick<StripRequest, "url" | "state">): void {
    this.hidden.delete(threadId);
    this.hidden.set(threadId, dismissalOf(request));
    while (this.hidden.size > LIMIT) this.hidden.delete(this.hidden.keys().next().value!);
    this.storage()?.set(KEY, JSON.stringify(Object.fromEntries(this.hidden)));
    this.version += 1;
    for (const listener of [...this.listeners]) listener();
  }
}
