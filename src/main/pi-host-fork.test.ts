import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiHost } from "./pi-host.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import { ThreadRuntime } from "./thread-runtime.js";

const made: string[] = [];
afterEach(async () => { await Promise.all(made.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

/** A saved thread in `/repo` with one answered prompt, active in a host whose runtimes are stubs. */
async function bench() {
  const sessions = await mkdtemp(join(tmpdir(), "tau-fork-"));
  made.push(sessions);
  const source = SessionManager.create("/repo", sessions);
  source.appendMessage({ role: "user", content: "write a.txt", timestamp: 1 } as never);
  const answer = source.appendMessage({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 2 } as never);
  const backend = {
    kind: "pi" as const, runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER, threadId: source.getSessionId(), providerSessionId: source.getSessionId(), cwd: "/repo",
    capabilities: { fork: { runtimeOwned: false } },
    state: () => ({ streaming: false, idle: true, hasMessages: true, sessionFile: source.getSessionFile(), activeTools: [], supportsImageInput: false, extensionCount: 0 }),
    dispose: async () => undefined,
  };
  const thread = new ThreadRuntime(backend as never, { session: { sessionId: source.getSessionId() }, dispose: async () => undefined } as never);
  const host = new PiHost("/repo", () => undefined, { list: () => [], isHidden: () => false } as never, false, false);
  const internals = host as unknown as Record<string, any>;
  internals.sessionsDirOverride = sessions;
  const opened: SessionManager[] = [];
  internals.requireActive = () => thread;
  internals.runtimes.open = async (manager: SessionManager) => { opened.push(manager); return thread; };
  internals.activateThread = async () => true;
  internals.publication.activeUpdates = async () => ({ version: 1, updates: [] });
  return { host, internals, opened, answer, sessions, threadId: source.getSessionId() };
}

describe("forking a thread", () => {
  it("runs the fork in the folder it names, its own worktree, with the conversation up to the entry", async () => {
    const { host, opened, answer, sessions, threadId } = await bench();
    await host.forkThread(answer, threadId, "/repo-worktrees/feat-x-2");
    const [fork] = opened;
    expect(fork?.getCwd()).toBe("/repo-worktrees/feat-x-2");
    expect(fork?.getSessionId()).not.toBe(threadId);
    expect(fork?.getSessionDir()).toBe(sessions);
    expect(fork?.getBranch().map((entry) => entry.type === "message" ? entry.message.role : entry.type)).toEqual(["user", "assistant"]);
  });

  it("registers a background fork without changing the active thread", async () => {
    const { host, internals, answer, threadId } = await bench();
    const fork = { threadId: "fork", releaseEventBarrier: vi.fn() };
    internals.runtimes.open = vi.fn(async () => fork);
    internals.adoptThread = vi.fn(async () => undefined);
    internals.index.refreshShell = vi.fn(async () => undefined);
    internals.activateThread = vi.fn();
    const result = await host.forkThread(answer, threadId, "/repo-worktrees/side-task", true);
    expect(result.forkedSessionId).toBe("fork");
    expect(internals.adoptThread).toHaveBeenCalledWith(fork);
    expect(internals.index.refreshShell).toHaveBeenCalledWith(fork, true);
    expect(internals.activateThread).not.toHaveBeenCalled();
    expect(fork.releaseEventBarrier).toHaveBeenCalledOnce();
  });

  it("keeps the source's folder when none is named", async () => {
    const { host, opened, answer, threadId } = await bench();
    await host.forkThread(answer, threadId);
    expect(opened[0]?.getCwd()).toBe("/repo");
  });
});
