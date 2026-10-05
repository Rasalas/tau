import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { registerThreadLinks, type ThreadLinks } from "./thread-links-host.js";
import { parseGitHubDetail, parseRequestUrl } from "./pull-request-json.js";
import type { SourceControl } from "./provider-registry.js";
import type { PullRequestDetail, ThreadPullRequestLink } from "./protocol.js";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

async function fixture(discovery?: { sessions: unknown[]; branch: string; state: "open" | "merged" }) {
  const directory = await mkdtemp(join(tmpdir(), "tau-review-links-"));
  directories.push(directory);
  const url = "https://github.com/acme/shop-api/pull/5";
  const ref = parseRequestUrl(url)!;
  const sample = parseGitHubDetail(ref, readFileSync(join(import.meta.dirname, "fixtures/gh-pr-view.json"), "utf8"));
  const detail: PullRequestDetail = { ...sample, headRef: "fix/tablet", headSha: "submitted-tip", baseRef: "release", state: "merged" };
  const reads = { detail: vi.fn(async () => detail) };
  const start = async () => {
    let links!: ThreadLinks;
    const registry = await activateHostKit({
      id: "tau.review", name: "Review", permissions: ["sessions", "runtime:extend"],
      activate(context) { links = registerThreadLinks(context, reads, async () => discovery ? { root: "/work", branch: discovery.branch, base: "main", remote: { url: "https://github.com/acme/shop-api.git" } } : undefined, {
        detect: async () => "github",
        get: () => ({ repository: () => ({ host: "github.com", repo: "acme/shop-api" }), missing: () => undefined, current: async () => ({ url, number: 5, state: discovery?.state, headRef: discovery?.branch, baseRef: "main", title: "Tablet" }) }),
      } as unknown as SourceControl); },
    }, { stateDir: directory, ...(discovery ? { sessions: { list: async () => discovery.sessions } as never } : {}) });
    return { links, registry };
  };
  return { directory, url, detail, reads, start };
}

describe("a local review's linked request", () => {
  it("keeps the submitted head and destination across a restart, without a provider read", async () => {
    const repo = await fixture();
    const first = await repo.start();
    await first.links.link("thread", repo.url, "created");
    first.links.dispose();
    repo.reads.detail.mockClear();
    const restarted = await repo.start();
    expect(await restarted.links.review(["thread"], "fix/tablet", "submitted-tip")).toEqual({
      target: "release", tip: "submitted-tip", merged: true, url: repo.url, number: 5,
    });
    expect(repo.reads.detail).not.toHaveBeenCalled();
    expect(await restarted.links.review(["thread"], "another-branch", "submitted-tip")).toBeUndefined();
    restarted.links.dispose();
  });

  it("refreshes an old merged link whose submitted commit was never saved", async () => {
    const repo = await fixture();
    const first = await repo.start();
    await first.links.link("thread", repo.url, "created");
    first.links.dispose();
    const file = join(repo.directory, "tau.review/thread-pull-requests.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    delete saved.threads.thread[0].headSha;
    saved.threads.thread[0].refreshedAt = 0;
    await writeFile(file, JSON.stringify(saved));
    const restarted = await repo.start();
    const before = await restarted.links.review(["thread"], "fix/tablet", "new-tip");
    expect(before?.tip).toBeUndefined();
    const links = await restarted.registry.invoke("tau.review", "thread-links", { threadId: "thread", refresh: true }) as ThreadPullRequestLink[];
    expect(links[0]?.headSha).toBe("submitted-tip");
    expect((await restarted.links.review(["thread"], "fix/tablet", "new-tip"))?.tip).toBe("submitted-tip");
    restarted.links.dispose();
  });
});


it("persists a discovered open PR and respects unlinking across restarts", async () => {
  const fixtureData = await fixture({ sessions: [{ sessionId: "thread", cwd: "/work" }], branch: "feature/tablet", state: "open" });
  const first = await fixtureData.start();
  expect(await first.registry.invoke("tau.review", "thread-links", { threadId: "thread" })).toEqual([expect.objectContaining({ source: "discovered", state: "open", url: fixtureData.url })]);
  await first.registry.invoke("tau.review", "unlink-pr", { threadId: "thread", url: fixtureData.url });
  first.links.dispose();
  const second = await fixtureData.start();
  expect(await second.registry.invoke("tau.review", "thread-links", { threadId: "thread" })).toEqual([]);
  second.links.dispose();
});

it.each([
  { branch: "feature/tablet", state: "merged" as const, sessions: [{ sessionId: "thread", cwd: "/work" }] },
  { branch: "main", state: "open" as const, sessions: [{ sessionId: "thread", cwd: "/work" }] },
  { branch: "feature/tablet", state: "open" as const, sessions: [{ sessionId: "thread", cwd: "/work" }, { sessionId: "other", cwd: "/work" }] },
])("does not infer ownership from old PRs, default branches or shared checkouts: %j", async (discovery) => {
  const data = await fixture(discovery);
  const started = await data.start();
  expect(await started.registry.invoke("tau.review", "thread-links", { threadId: "thread" })).toEqual([]);
  started.links.dispose();
});
