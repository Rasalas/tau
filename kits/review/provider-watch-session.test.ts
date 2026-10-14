import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { readWatchSnapshot } from "./pr-watch-github.js";
import { parseRequestUrl } from "./pull-request-json.js";
import { createSourceControl, type SourceControl } from "./provider-registry.js";
it("shares credential resolution, pins each request, isolates quota gates, and sanitizes auth failures", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tau-watch-session-"));
  let sources!: SourceControl, token = "test-first", authFailure = false, limited = false;
  const run = vi.fn(async (_command: string, args: string[], _cwd: string, options?: { env?: Record<string, string> }) => {
    if (args[0] === "auth") {
      if (authFailure) throw new Error("sensitive auth failure");
      return token;
    }
    if (limited && options?.env?.GH_TOKEN === "test-first") throw new Error("HTTP/2.0 403 Forbidden\nX-RateLimit-Reset: 3600\nAPI rate limit exceeded");
    return "ok";
  });
  const registry = await activateHostKit({ id: "tau.review", name: "Review", permissions: ["process", "network", "machines"], activate: (context) => {
    sources = createSourceControl(context, { run, now: () => 0 });
    return () => sources.dispose();
  } }, { stateDir, findCommand: () => "/bin/gh", noteSubprocess: () => undefined });
  try {
    const [first, shared] = await Promise.all([sources.tools.githubSession!("github.com"), sources.tools.githubSession!("github.com")]);
    expect(first.identity).toBe(shared.identity);
    expect(first.identity).not.toContain(token);
    expect(run).toHaveBeenCalledOnce();
    token = "test-second";
    const second = await sources.tools.githubSession!("github.com");
    expect(second.identity).not.toBe(first.identity);
    const read = (session: typeof first) => session.cli("github", { args: ["api", "--include"] }, "Reading", { host: "github.com" });
    limited = true;
    await expect(read(first)).rejects.toMatchObject({ retryAt: 3_600_000 });
    const count = run.mock.calls.length;
    await expect(read(first)).rejects.toMatchObject({ retryAt: 3_600_000 });
    expect(run).toHaveBeenCalledTimes(count);
    expect(await read(second)).toBe("ok");
    expect(run.mock.calls.at(-1)?.[3]?.env).toEqual({ GH_TOKEN: "test-second", GH_ENTERPRISE_TOKEN: "test-second" });
    authFailure = true;
    await expect(sources.tools.githubSession!("github.com")).rejects.toThrow("could not resolve its signed-in credential");
  } finally { await registry.deactivate("tau.review"); await rm(stateDir, { recursive: true, force: true }); }
});

// A local executable emits gh's real HTTP-200 GraphQL failure shape. No network or real credentials.
it("keeps healthy aliases readable across repeated nonzero CLI responses for an inaccessible PR", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "tau-watch-partial-"));
  const command = join(stateDir, "dummy-gh");
  const page = { nodes: [], pageInfo: { hasNextPage: false } };
  const pr = { id: "pr", state: "OPEN", headRefOid: "head", comments: page, reviews: page, reviewThreads: page };
  await writeFile(command, String.raw`#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "auth") { console.log("dummy-secret"); process.exit(0); }
if (args[0] === "malformed") { console.error("gh: dummy-secret malformed response"); process.exit(1); }
const query = args.find(arg => arg.startsWith("query="));
const batch = query.includes("p1: repository");
const limited = query.includes("number:44");
const errors = [{ path: [batch ? "p1" : "p0"], type: limited ? "RATE_LIMITED" : "NOT_FOUND", message: limited ? "API rate limit exceeded" : "Could not resolve repository" }];
console.log('HTTP/2.0 200 OK\nRetry-After: 3600\n\n' + JSON.stringify({data: batch ? {p0: {pullRequest: ${JSON.stringify(pr)}}, p1: null} : {p0: null}, errors}));
console.error("gh: dummy-secret inaccessible repository");
process.exit(1);
`, { mode: 0o700 });
  let now = 0, subprocesses = 0, sources!: SourceControl;
  const registry = await activateHostKit({ id: "tau.review", name: "Review", permissions: ["process", "network", "machines"], activate: (context) => {
    sources = createSourceControl(context, { now: () => now });
    return () => sources.dispose();
  } }, { stateDir, findCommand: () => command, noteSubprocess: () => { subprocesses++; } });
  try {
    const ref = (number: number) => parseRequestUrl(`https://github.com/owner/repo/pull/${number}`)!;
    for (let poll = 0; poll < 18; poll++) {
      now = poll * 60_000;
      // oxlint-disable-next-line no-await-in-loop -- repeated fresh polls exceed the unreadable deadline.
      const [healthy, inaccessible] = await Promise.allSettled([readWatchSnapshot(sources.tools, ref(42)), readWatchSnapshot(sources.tools, ref(43))]);
      expect(subprocesses).toBe((poll + 1) * 3); // one credential, batch, and bounded fallback
      expect(healthy, String(healthy.status === "rejected" && healthy.reason)).toMatchObject({ status: "fulfilled", value: { head: "head" } });
      expect(inaccessible).toMatchObject({ status: "rejected", reason: { message: "GitHub did not return a readable pull request." } });
      expect(String(inaccessible.status === "rejected" && inaccessible.reason)).not.toContain("dummy-secret");
    }
    const session = await sources.tools.githubSession!("github.com");
    await expect(session.cli("github", { args: ["malformed"] }, "Reading", { host: "github.com" })).rejects.toThrow("[redacted] malformed response");
    await expect(readWatchSnapshot(sources.tools, ref(44))).rejects.toMatchObject({ retryAt: now + 3_600_000 });
    await expect(readWatchSnapshot(sources.tools, ref(42))).rejects.toMatchObject({ retryAt: now + 3_600_000 });
  } finally { await registry.deactivate("tau.review"); await rm(stateDir, { recursive: true, force: true }); }
});
