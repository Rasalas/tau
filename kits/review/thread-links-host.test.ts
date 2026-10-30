import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { registerThreadLinks } from "./thread-links-host.js";
import type { SourceControl } from "./provider-registry.js";
import type { PullRequestDetail } from "./protocol.js";

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tau-discovery-cost-"));
  directories.push(directory);
  let now = 2_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let branch = "feature/one";
  let number = 5;
  const current = vi.fn(async () => ({ url: `https://github.com/acme/repo/pull/${number}`, number, state: "open", headRef: branch, baseRef: "main", title: "Feature", draft: false }));
  const workspace = vi.fn(async () => ({ root: "/work", branch, base: "main", remote: { name: "origin", url: "https://github.com/acme/repo.git" } }));
  const detail = vi.fn(async () => ({ title: "Feature", state: "open", draft: false, headRef: branch, headSha: "tip", baseRef: "main" }) as PullRequestDetail);
  const sessions = vi.fn(async () => [{ sessionId: "thread", cwd: "/work" }]);
  const registry = await activateHostKit({
    id: "tau.review", name: "Review", permissions: ["sessions", "runtime:extend"],
    activate(context) {
      return registerThreadLinks(context, { detail }, workspace, {
        detect: async () => "github",
        get: () => ({ repository: () => ({ host: "github.com", repo: "acme/repo" }), missing: () => undefined, current }),
      } as unknown as SourceControl).dispose;
    },
  }, { stateDir: directory, sessions: { list: sessions } as never });
  const links = (refresh?: boolean | "force") => registry.invoke("tau.review", "thread-links", { threadId: "thread", ...(refresh !== undefined ? { refresh } : {}) });
  return { links, workspace, current, detail, sessions, advance: (ms = 60_001) => { now += ms; }, changeBranch: () => { branch = "feature/two"; number = 6; }, newRequest: () => { number++; } };
}

it("reuses an open linked branch while still discovering a changed branch and honoring force", async () => {
  const space = await fixture();
  await space.links();
  space.advance();
  await space.links();
  expect(space.workspace).toHaveBeenCalledTimes(2);
  expect(space.current).toHaveBeenCalledTimes(1);
  space.advance();
  space.changeBranch();
  expect(await space.links()).toEqual(expect.arrayContaining([expect.objectContaining({ number: 6, headRef: "feature/two" })]));
  expect(space.current).toHaveBeenCalledTimes(2);
  space.newRequest();
  await space.links("force");
  expect(space.current).toHaveBeenCalledTimes(3);
});

it("makes concurrent consumers await one completed discovery", async () => {
  const space = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const original = space.workspace.getMockImplementation()!;
  space.workspace.mockImplementationOnce(async () => { await gate; return original(); });
  const first = space.links();
  const second = space.links();
  release();
  const answers = await Promise.all([first, second]);
  expect(answers).toEqual([
    [expect.objectContaining({ number: 5 })],
    [expect.objectContaining({ number: 5 })],
  ]);
  expect(space.workspace).toHaveBeenCalledTimes(1);
  expect(space.current).toHaveBeenCalledTimes(1);
});

it("periodically discovers another request even while the same branch retains an open link", async () => {
  const space = await fixture();
  await space.links();
  space.newRequest();
  space.advance(5 * 60_000 + 1);
  expect(await space.links()).toEqual(expect.arrayContaining([expect.objectContaining({ number: 6 })]));
  expect(space.current).toHaveBeenCalledTimes(2);
});

it("coalesces concurrent forced refreshes without losing their fresh provider read", async () => {
  const space = await fixture();
  await space.links();
  const answers = await Promise.all([space.links("force"), space.links("force")]);
  expect(answers.every((answer) => (answer as unknown[]).length === 1)).toBe(true);
  expect(space.current).toHaveBeenCalledTimes(2);
  expect(space.detail).toHaveBeenCalledTimes(1);
});

it("runs an explicit fresh read after an already-running automatic refresh", async () => {
  const space = await fixture();
  await space.links();
  space.advance();
  await Promise.all([space.links(true), space.links("force")]);
  expect(space.current).toHaveBeenCalledTimes(2);
  expect(space.detail).toHaveBeenCalledTimes(2);
});

it("keeps when a linked request merged, then stops reading it", async () => {
  const space = await fixture();
  await space.links();
  space.detail.mockResolvedValue({ title: "Feature", state: "merged", draft: false, headRef: "feature/one", headSha: "tip", baseRef: "main", mergedAt: "2026-10-14T21:01:00Z" } as PullRequestDetail);
  space.advance();
  expect(await space.links(true)).toEqual([expect.objectContaining({ state: "merged", endedAt: Date.parse("2026-10-14T21:01:00Z") })]);
  const reads = space.detail.mock.calls.length;
  space.advance();
  await space.links(true);
  expect(space.detail).toHaveBeenCalledTimes(reads);
});

it("drops the end when a closed request opens again", async () => {
  const space = await fixture();
  await space.links();
  space.detail.mockResolvedValue({ title: "Feature", state: "closed", draft: false, headRef: "feature/one", headSha: "tip", baseRef: "main", closedAt: "2026-10-14T21:01:00Z" } as PullRequestDetail);
  space.advance();
  expect(await space.links(true)).toEqual([expect.objectContaining({ state: "closed", endedAt: Date.parse("2026-10-14T21:01:00Z") })]);
  space.detail.mockResolvedValue({ title: "Feature", state: "open", draft: false, headRef: "feature/one", headSha: "tip", baseRef: "main" } as PullRequestDetail);
  space.advance(30 * 60_000 + 1);
  const [reopened] = await space.links(true) as { state: string; endedAt?: number }[];
  expect(reopened).toMatchObject({ state: "open" });
  expect(reopened!.endedAt).toBeUndefined();
});

it("tells every runtime's agent how to link requests and put pictures in them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-pr-instructions-"));
  directories.push(directory);
  const instructions: Array<() => string | undefined> = [];
  const hooks: Array<(event: { systemPrompt: string }) => { systemPrompt: string }> = [];
  await activateHostKit({
    id: "tau.review", name: "Review", permissions: ["sessions", "runtime:extend"],
    activate(context) {
      return registerThreadLinks(context, { detail: vi.fn() } as never, vi.fn() as never, { detect: async () => undefined } as unknown as SourceControl).dispose;
    },
  }, {
    stateDir: directory,
    sessions: { list: async () => [] } as never,
    registerRuntimeExtension: ((_name: string, setup: (pi: unknown) => void) => {
      setup({ registerTool: () => undefined, on: (event: string, hook: (typeof hooks)[number]) => { if (event === "before_agent_start") hooks.push(hook); } });
      return () => undefined;
    }) as never,
    mcp: { registerTools: () => () => undefined, gate: () => () => undefined, registerInstructions: (provider: () => string | undefined) => { instructions.push(provider); return () => undefined; }, connect: async () => undefined } as never,
  });
  const pi = hooks[0]!({ systemPrompt: "base" }).systemPrompt;
  const mcp = instructions.map((provider) => provider()).join("\n");
  for (const text of [pi, mcp]) {
    expect(text).toContain("<pull_request_linking>");
    expect(text).toContain("<pull_request_media>");
    expect(text).toContain("--attach");
    expect(text).toContain("GitHub CLI 2.99");
    expect(text).toContain('"Attached files"');
  }
  expect(pi.startsWith("base\n\n")).toBe(true);
});
