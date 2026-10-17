import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HostCommandError, type HostExtensionServices } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createWorktree } from "./workspace-worktrees.js";
import { registerWorktreeStorage } from "./worktree-storage-host.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

it("includes other local runtimes in settle retention and fails closed on missing metadata or index reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "tau-storage-host-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo"); await mkdir(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe", encoding: "utf8" });
  git("init", "-q", "-b", "main"); git("config", "user.name", "Tau"); git("config", "user.email", "tau@example.test");
  await writeFile(join(repo, "file.txt"), "fixture\n"); git("add", "."); git("commit", "-qm", "fixture");
  const path = await createWorktree(repo, "retained");
  const started = Date.now();
  const indexed = [
    { id: "codex", path: "tau-thread:codex:codex", title: "Codex", projectPath: path, projectName: "repo", modifiedAt: started, messageCount: 1, backendKind: "codex" },
    { id: "rex~remote", path: "tau-thread:machine:rex~remote", title: "Remote", projectPath: path, projectName: "repo", modifiedAt: started, messageCount: 1, backendKind: "machine" },
  ];
  const refreshIndex = vi.fn<HostExtensionServices["sessions"]["refreshIndex"]>(async () => ({ version: 1, type: "thread-index", index: { projects: [], sessions: indexed } }));
  let registration: ReturnType<typeof registerWorktreeStorage> | undefined;
  let settlements: Record<string, number> = { pi: started };
  let unavailable = false;
  const readSettlements = vi.fn(() => {
    if (unavailable) throw new HostCommandError("Settlement metadata is unavailable.");
    return settlements;
  });
  const registry = await activateHostKit({
    id: "tau.workspace", name: "Workspace", permissions: ["sessions", "process", "workspace:read"],
    activate(context) {
      registration = registerWorktreeStorage(context, { removed: () => undefined });
      return () => registration!.dispose();
    },
  }, {
    stateDir: join(root, "state"), cwd: () => repo, thread: () => undefined, noteSubprocess: () => undefined,
    sessions: {
      list: async () => [{ sessionId: "pi", path: join(root, "pi-session.jsonl"), cwd: path }],
      trash: async () => [], refreshIndex,
      open: vi.fn(), prepare: vi.fn(), start: vi.fn(), remove: vi.fn(), restore: vi.fn(), purge: vi.fn(), exclusive: (work) => work(),
    },
  });
  cleanup.push(() => registry.dispose());
  await registry.activate({
    id: "tau.thread-rail", name: "Thread Rail",
    activate(context) { context.registerCommand("thread-settlements", readSettlements, { access: "read", callers: ["tau.workspace"] }); },
  });
  const storage = registration!.storage;
  await storage.remember(path, repo, "retained");
  await storage.report({ sizes: false });
  expect(refreshIndex).not.toHaveBeenCalled();
  expect(readSettlements).not.toHaveBeenCalled();
  await storage.setPolicy({ rules: { afterSettledDays: 1 } });
  vi.spyOn(Date, "now").mockReturnValue(started + 2 * 86_400_000);
  const due = async () => (await storage.report({ sizes: false })).worktrees[0]!.verdict.remove;
  expect(await due()).toBe(false); // Active Codex shares the Pi thread's worktree.
  expect(readSettlements).toHaveBeenLastCalledWith({ threadIds: ["pi", "codex"] }, expect.anything());
  settlements = { pi: started, codex: started };
  expect(await due()).toBe(true); // The active peer machine is not a local owner.
  indexed[0]!.modifiedAt = Date.now();
  expect(await due()).toBe(false);
  indexed[0]!.modifiedAt = started;
  unavailable = true;
  expect(await due()).toBe(false);
  unavailable = false;
  refreshIndex.mockRejectedValueOnce(new Error("Index unavailable"));
  await expect(storage.sweep()).rejects.toThrow("Index unavailable");
  expect(existsSync(path)).toBe(true);
});
