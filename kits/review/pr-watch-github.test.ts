import { afterEach, expect, it, vi } from "vitest";
import { ProviderReadCache } from "./provider-read-cache.js";
import type { ProviderTools } from "./provider.js";
import { parseRequestUrl } from "./pull-request-json.js";
import { readWatchSnapshot } from "./pr-watch-github.js";
import { watchChanges } from "./pr-watch-protocol.js";
const ref = (number = 42, host = "github.com") => parseRequestUrl(`https://${host}/owner/repo/pull/${number}`)!;
const page = <T>(nodes: T[], more = false, cursor = "next") => ({ nodes, pageInfo: { hasNextPage: more, endCursor: cursor } });
const remark = (id: string, updatedAt = "one", login = "human") => ({ id, updatedAt, author: { login } });
const pr = () => ({ id: "pr", state: "OPEN", headRefOid: "head", comments: page([remark("old"), remark("new")]), reviews: page([remark("review-old"), remark("review-new")]), reviewThreads: page([{ id: "thread", comments: page([remark("reply-old"), remark("reply-new")]) }]) });
const caches: ProviderReadCache[] = [];
afterEach(() => { for (const cache of caches.splice(0)) cache.dispose(); });
function harness() {
  let identity = "account-1";
  const cache = new ProviderReadCache(Date.now); caches.push(cache);
  const cli = vi.fn(async (_kind: string, call: { args: string[] }) => {
    const query = call.args.find((arg) => arg.startsWith("query="))!;
    const aliases = [...query.matchAll(/p(\d+): repository/gu)];
    return JSON.stringify({ data: { viewer: { login: "agent" }, ...Object.fromEntries(aliases.map((match) => [`p${match[1]}`, { pullRequest: pr() }])) } });
  });
  const tools = { cli, now: Date.now, githubSession: async () => ({ identity, cli }), cached: <T>(kind: string, request: { url: string }, fresh: boolean, read: () => Promise<T>, coalesce: boolean) => cache.read(`${kind}\0${request.url}`, fresh, read, coalesce) } as unknown as ProviderTools;
  return { tools, cli, switch: () => { identity = "account-2"; } };
}
it("detects older edits in every remark kind and preserves same-account human and cross-thread additions and edits", async () => {
  const h = harness(), before = await readWatchSnapshot(h.tools, ref());
  for (const kind of ["comment", "review", "reply"]) {
    const current = pr();
    const rows = kind === "comment" ? current.comments.nodes : kind === "review" ? current.reviews.nodes : current.reviewThreads.nodes[0]!.comments.nodes;
    rows[0]!.updatedAt = "edited";
    h.cli.mockResolvedValueOnce(JSON.stringify({ data: { viewer: { login: "agent" }, p0: { pullRequest: current } } }));
    // oxlint-disable-next-line no-await-in-loop -- each edit is a separate poll.
    expect(watchChanges(before, await readWatchSnapshot(h.tools, ref()))).toEqual(["new comments or reviews"]);
  }
  // Login cannot distinguish a human, this thread's agent, or another thread.
  for (const origin of ["same-account-human", "other-thread", "agent-remark-edited-by-human"]) {
    for (const kind of ["comment", "review", "reply"]) {
      const current = pr();
      const rows = kind === "comment" ? current.comments.nodes : kind === "review" ? current.reviews.nodes : current.reviewThreads.nodes[0]!.comments.nodes;
      rows.push(remark(origin, "one", "agent"));
      h.cli.mockResolvedValueOnce(JSON.stringify({ data: { viewer: { login: "agent" }, p0: { pullRequest: current } } }));
      // oxlint-disable-next-line no-await-in-loop -- separate fresh polls for additions and edits.
      const added = await readWatchSnapshot(h.tools, ref());
      expect(watchChanges(before, added)).toEqual(["new comments or reviews"]);
      rows.at(-1)!.updatedAt = "human-edit";
      h.cli.mockResolvedValueOnce(JSON.stringify({ data: { viewer: { login: "agent" }, p0: { pullRequest: current } } }));
      // oxlint-disable-next-line no-await-in-loop -- verify same-ID edits as a subsequent poll.
      expect(watchChanges(added, await readWatchSnapshot(h.tools, ref()))).toEqual(["new comments or reviews"]);
    }
  }
});
it("batches five aliases at a time and separates hosts and credential identities", async () => {
  const h = harness();
  await Promise.all(Array.from({ length: 26 }, (_, i) => readWatchSnapshot(h.tools, ref(i + 1))));
  expect(h.cli).toHaveBeenCalledTimes(6);
  h.cli.mockClear();
  const first = readWatchSnapshot(h.tools, ref());
  h.switch();
  await Promise.all([first, readWatchSnapshot(h.tools, ref(43)), readWatchSnapshot(h.tools, ref(44, "github.example.com"))]);
  expect(h.cli).toHaveBeenCalledTimes(3);
});
it("shares unfinished reads but a forced read after completion sees the changed fingerprint", async () => {
  const h = harness();
  let resolve!: (value: string) => void;
  h.cli.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const first = readWatchSnapshot(h.tools, ref());
  await vi.waitFor(() => expect(h.cli).toHaveBeenCalledOnce());
  const shared = readWatchSnapshot(h.tools, ref());
  await Promise.resolve();
  const current = pr(); current.comments.nodes[0]!.updatedAt = "changed";
  resolve(JSON.stringify({ data: { viewer: { login: "agent" }, p0: { pullRequest: pr() } } }));
  expect(await shared).toEqual(await first);
  h.cli.mockResolvedValueOnce(JSON.stringify({ data: { viewer: { login: "agent" }, p0: { pullRequest: current } } }));
  expect((await readWatchSnapshot(h.tools, ref())).comments).toContain("changed");
  expect(h.cli).toHaveBeenCalledTimes(2);
});
it("recovers missing aliases independently without discarding readable batch answers", async () => {
  const h = harness();
  h.cli.mockResolvedValueOnce(JSON.stringify({ data: { viewer: { login: "agent" }, p0: { pullRequest: pr() } }, errors: [{ path: ["p1"], message: "unavailable" }] }));
  const results = await Promise.all([readWatchSnapshot(h.tools, ref()), readWatchSnapshot(h.tools, ref(43))]);
  expect(results.map((result) => result.head)).toEqual(["head", "head"]);
  expect(h.cli).toHaveBeenCalledTimes(2);
});
it("paginates beyond 100 comments, reviews, threads and replies, including older edits", async () => {
  const h = harness(), current = pr();
  current.comments = page(Array.from({ length: 100 }, (_, i) => remark(`comment-${i}`)), true);
  current.reviews = page(Array.from({ length: 100 }, (_, i) => remark(`review-${i}`)), true);
  current.reviewThreads = page(Array.from({ length: 100 }, (_, i) => ({ id: `thread-${i}`, comments: page(i === 0 ? Array.from({ length: 100 }, (_reply, n) => remark(`reply-${n}`)) : [], i === 0) })), true);
  h.cli.mockImplementation(async (_kind, call) => {
    const query = call.args.find((arg) => arg.startsWith("query="))!;
    if (query.includes("repository")) return JSON.stringify({ data: { viewer: { login: "agent" }, p0: { pullRequest: current } } });
    const field = query.includes("reviewThreads(first") ? "reviewThreads" : query.includes("reviews(first") ? "reviews" : "comments";
    const rows = field === "reviewThreads" ? [{ id: "thread-extra", comments: page([remark("reply-extra")]) }] : [remark(query.includes("ReviewThread") ? "reply-101" : `${field}-101`, "edited")];
    return JSON.stringify({ data: { node: { [field]: page<unknown>(rows, false, "end") } } });
  });
  const result = await readWatchSnapshot(h.tools, ref());
  expect(result.comments).toContain("comments-101"); expect(result.comments).toContain("reviews-101"); expect(result.comments).toContain("reply-101"); expect(result.comments).toContain("reply-extra");
  expect(h.cli).toHaveBeenCalledTimes(5);
});
it("refuses repeated cursors rather than accepting partial coverage", async () => {
  const h = harness(), current = pr(); current.comments.pageInfo.hasNextPage = true;
  h.cli.mockResolvedValueOnce(JSON.stringify({ data: { viewer: { login: "agent" }, p0: { pullRequest: current } } }));
  h.cli.mockResolvedValueOnce(JSON.stringify({ data: { node: { comments: page([remark("extra")], true) } } }));
  await expect(readWatchSnapshot(h.tools, ref())).rejects.toThrow("complete PR watch coverage");
});
it("recognizes HTTP-200 GraphQL quota errors and Retry-After without misreading check names", async () => {
  const h = harness();
  h.cli.mockResolvedValueOnce('HTTP/2.0 200 OK\nRetry-After: 3600\n\n{"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded"}]}');
  await expect(readWatchSnapshot(h.tools, ref())).rejects.toMatchObject({ retryAt: expect.any(Number) });
  const current = { ...pr(), commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: page([{ databaseId: 1, name: "rate limit tests", status: "COMPLETED", conclusion: "SUCCESS" }]) } } }] } };
  h.cli.mockResolvedValueOnce(JSON.stringify({ data: { viewer: { login: "agent" }, p0: { pullRequest: current } } }));
  expect((await readWatchSnapshot(h.tools, ref())).checks).toBe("done");
});
it("does not join an old credential's in-flight answer after switching the same PR to another credential", async () => {
  const h = harness();
  let resolve!: (value: string) => void;
  h.cli.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const old = readWatchSnapshot(h.tools, ref());
  await vi.waitFor(() => expect(h.cli).toHaveBeenCalledOnce());
  h.switch();
  h.cli.mockResolvedValueOnce(JSON.stringify({ data: { viewer: { login: "agent" }, p0: { pullRequest: { ...pr(), headRefOid: "new-account-head" } } } }));
  expect((await readWatchSnapshot(h.tools, ref())).head).toBe("new-account-head");
  resolve(JSON.stringify({ data: { viewer: { login: "agent" }, p0: { pullRequest: pr() } } }));
  expect((await old).head).toBe("head");
  expect(h.cli).toHaveBeenCalledTimes(2);
});
it("stops pagination at the documented page budget without adopting a partial fingerprint", async () => {
  const h = harness(), current = pr();
  current.comments = page([remark("first")], true, "0");
  h.cli.mockResolvedValueOnce(JSON.stringify({ data: { viewer: { login: "agent" }, p0: { pullRequest: current } } }));
  let cursor = 0;
  h.cli.mockImplementation(async () => JSON.stringify({ data: { node: { comments: page([remark("extra")], true, String(++cursor)) } } }));
  await expect(readWatchSnapshot(h.tools, ref())).rejects.toThrow("pagination limit");
  expect(h.cli).toHaveBeenCalledTimes(30);
});
