import type { ThreadPullRequestLink } from "./protocol.js";
import { parseRequestUrl } from "./pull-request-json.js";

export interface ThreadPullRequestsParams extends Record<string, unknown> {
  threadId: string;
  workspace?: string;
  /** A rail badge may also include its checkout's request before discovery has linked it. */
  branchUrl?: string;
  /** The overview restores the position a request was opened from. */
  scrollTop?: number;
}

export function threadPullRequestsParams(value: Record<string, unknown>): ThreadPullRequestsParams | undefined {
  if (typeof value.threadId !== "string" || !value.threadId) return undefined;
  return { threadId: value.threadId, ...(typeof value.workspace === "string" ? { workspace: value.workspace } : {}), ...(typeof value.branchUrl === "string" && parseRequestUrl(value.branchUrl) ? { branchUrl: value.branchUrl } : {}), ...(typeof value.scrollTop === "number" && Number.isFinite(value.scrollTop) && value.scrollTop >= 0 ? { scrollTop: value.scrollTop } : {}) };
}

export interface ThreadRequestNode<T> {
  request: T;
  children: ThreadRequestNode<T>[];
}

type BranchRequest = Pick<ThreadPullRequestLink, "url" | "service" | "host" | "repo" | "number" | "linkedAt" | "headRef" | "baseRef">;

/** A branch name only identifies a dependency within its own repository. */
const branchKey = (request: BranchRequest, branch: string) => JSON.stringify([request.service, request.host.toLowerCase(), request.repo.toLowerCase(), branch]);

/** Base requests first, their dependants underneath. Ambiguous heads and cycles stay at the root. */
export function threadRequestTree<T extends BranchRequest>(requests: readonly T[]): ThreadRequestNode<T>[] {
  const ordered = [...new Map(requests.map((request) => [request.url, request])).values()]
    .sort((a, b) => b.linkedAt - a.linkedAt || b.number - a.number || a.url.localeCompare(b.url));
  const heads = new Map<string, T[]>();
  for (const request of ordered) {
    if (!request.headRef) continue;
    const key = branchKey(request, request.headRef);
    heads.set(key, [...heads.get(key) ?? [], request]);
  }
  const parents = new Map<string, string>();
  for (const request of ordered) {
    if (!request.baseRef) continue;
    const candidates = (heads.get(branchKey(request, request.baseRef)) ?? []).filter((candidate) => candidate.url !== request.url);
    if (candidates.length === 1) parents.set(request.url, candidates[0]!.url);
  }
  const cyclic = new Set<string>();
  for (const request of ordered) {
    const path: string[] = [];
    let url: string | undefined = request.url;
    while (url) {
      const at = path.indexOf(url);
      if (at >= 0) { for (const member of path.slice(at)) cyclic.add(member); break; }
      path.push(url);
      url = parents.get(url);
    }
  }
  for (const url of cyclic) parents.delete(url);
  const nodes = new Map(ordered.map((request) => [request.url, { request, children: [] } as ThreadRequestNode<T>]));
  const roots: ThreadRequestNode<T>[] = [];
  for (const request of ordered) {
    const node = nodes.get(request.url)!;
    const parent = parents.get(request.url);
    if (parent) nodes.get(parent)!.children.push(node); else roots.push(node);
  }
  return roots;
}
