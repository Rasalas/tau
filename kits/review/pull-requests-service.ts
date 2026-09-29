import type { ThreadPullRequest, ThreadPullRequestsService } from "tau";
import type { ThreadPullRequestLink } from "./protocol.js";
import type { ThreadLinkRows } from "./thread-links-store.js";

/** A link as the public service shows it: what a request is, not how the kit keeps it. */
function publicRequest(link: ThreadPullRequestLink): ThreadPullRequest {
  return {
    url: link.url,
    number: link.number,
    host: link.host,
    repo: link.repo,
    ...(link.title ? { title: link.title } : {}),
    ...(link.state ? { state: link.state } : {}),
    ...(link.draft ? { draft: true } : {}),
    ...(link.headRef ? { headRef: link.headRef } : {}),
    ...(link.baseRef ? { baseRef: link.baseRef } : {}),
  };
}

/** A thread's linked requests, as `THREAD_PULL_REQUESTS_SERVICE` hands them to other packages. */
export function threadPullRequestsService(links: Pick<ThreadLinkRows, "ensure" | "get" | "subscribe">): ThreadPullRequestsService {
  const shown = new Map<string, { source: readonly ThreadPullRequestLink[]; requests: readonly ThreadPullRequest[] }>();
  return {
    forThread: (sessionId) => {
      links.ensure(sessionId);
      const source = links.get(sessionId);
      const known = shown.get(sessionId);
      if (known?.source === source) return known.requests;
      const requests = source.map(publicRequest);
      shown.set(sessionId, { source, requests });
      return requests;
    },
    subscribe: (listener) => links.subscribe(listener),
  };
}
