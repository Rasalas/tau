import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostExtensionServices } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
// Test only: the two kits meet through the host registry, as they do in the app.
import { createWorkspaceHostExtension } from "../workspace/host.js";
import { createProjectScriptsHostExtension } from "./host.js";
import { SETUP_EVENT, type UiWorktreeSetup } from "./protocol.js";

const made: string[] = [];
afterEach(async () => { await Promise.all(made.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

/** A repository with one commit whose worktrees go to a folder of this test's own. */
async function repository(projectFile: Record<string, unknown>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tau-worktree-setup-")));
  made.push(root);
  const repo = join(root, "repo");
  await mkdir(join(repo, ".tau"), { recursive: true });
  await writeFile(join(repo, ".tau", "project.json"), JSON.stringify({ worktreeDirectory: join(root, "worktrees"), ...projectFile }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "tau@example.com");
  git("config", "user.name", "Tau");
  git("add", "-A");
  git("commit", "-qm", "initial commit");
  return repo;
}

async function workspaceKit(repo: string, withProjectScripts: boolean) {
  const logs: Array<[string, string | undefined]> = [];
  const services: Partial<HostExtensionServices> = {
    cwd: () => repo,
    knownWorkspacePath: async (path) => path,
    workspaceRef: (path: string) => ({ workspaceId: `ws1_${path}`, displayPath: path }),
    admitWorkspace: (path: string) => ({ workspaceId: `ws1_${path}`, displayPath: path }),
    projectName: async () => "repo",
    rememberProjectName: () => undefined,
    noteSubprocess: () => undefined,
    thread: () => undefined,
    log: (label, detail) => { logs.push([label, detail]); },
    // What Workspace Kit's activation reaches for; none of it is under test here.
    openWorkspace: async () => ({ version: 1 as const, updates: [] }),
    pickDirectory: async () => undefined,
    runtimeOwner: () => "tau" as const,
    setThreadTitle: async () => undefined,
    attachedRuntime: () => undefined,
    describeProjects: () => () => undefined,
    findCommand: () => undefined,
    sessions: { list: async () => [] } as unknown as HostExtensionServices["sessions"],
    clients: { observe: () => () => undefined, count: () => 1 },
    registerThreadLifecycle: () => () => undefined,
    registerTurnObserver: () => () => undefined,
    pinTranscriptEntries: () => () => undefined,
    decorateUiPrompt: () => () => undefined,
    registerRuntimeExtension: () => () => undefined,
    setPermissionLevel: () => undefined,
    registerRuntimeBackend: () => () => undefined,
    presentUi: () => () => undefined,
  };
  const setups: UiWorktreeSetup[] = [];
  const waiters: Array<{ match(setup: UiWorktreeSetup): boolean; resolve(setup: UiWorktreeSetup): void }> = [];
  const publish = (event: PublishedKitEvent) => {
    if (event.name !== SETUP_EVENT) return;
    const setup = event.payload as UiWorktreeSetup;
    setups.push(setup);
    for (const waiter of waiters.splice(0)) {
      if (waiter.match(setup)) waiter.resolve(setup);
      else waiters.push(waiter);
    }
  };
  /** The next setup push that matches; one already pushed counts. */
  const setupWhere = (match: (setup: UiWorktreeSetup) => boolean) => {
    const seen = setups.find(match);
    return seen ? Promise.resolve(seen) : new Promise<UiWorktreeSetup>((resolve) => waiters.push({ match, resolve }));
  };
  const registry = await activateHostKit(createWorkspaceHostExtension(), services, publish);
  if (withProjectScripts) await registry.activate(createProjectScriptsHostExtension({ watch: false }));
  const createWorktree = async (branch: string) => {
    const ref = await registry.invoke("tau.workspace", "create-worktree", { branch, workspace: repo }) as { displayPath: string };
    return ref.displayPath;
  };
  const scripts = (command: string, input?: unknown) => registry.invoke("tau.project-scripts", command, input);
  return { registry, logs, createWorktree, setups, setupWhere, scripts };
}

const running = (scriptId: string) => (setup: UiWorktreeSetup) =>
  setup.stages.some((stage) => stage.id === `script:${scriptId}` && stage.status === "running");

describe("worktree setup on the script definitions", () => {
  it("runs the blocking setup scripts, the old string among them, before the worktree is handed back", async () => {
    const repo = await repository({
      runOnWorktreeCreate: "echo legacy > legacy.txt",
      scripts: [
        { name: "Install", command: 'printf "%s" "$TAU_PROJECT_ROOT" > install.txt', runOnWorktreeCreate: true, async: false },
        { name: "Serve", command: "echo never > serve.txt" },
      ],
    });
    const kit = await workspaceKit(repo, true);
    const worktree = await kit.createWorktree("feature-setup");
    expect(await readFile(join(worktree, "legacy.txt"), "utf8")).toBe("legacy\n");
    expect(await readFile(join(worktree, "install.txt"), "utf8")).toBe(repo);
    expect(existsSync(join(worktree, "serve.txt"))).toBe(false);
    expect(kit.logs.map(([label]) => label)).not.toContain("git.worktree.setup-fallback");
    await kit.registry.deactivate("tau.project-scripts");
  });

  it("keeps running the old string itself when Project Scripts is off", async () => {
    const repo = await repository({ runOnWorktreeCreate: "echo legacy > legacy.txt" });
    const kit = await workspaceKit(repo, false);
    const worktree = await kit.createWorktree("feature-fallback");
    expect(await readFile(join(worktree, "legacy.txt"), "utf8")).toBe("legacy\n");
    expect(kit.logs.map(([label]) => label)).toContain("git.worktree.setup-fallback");
  });

  it("reports every step of the setup, and a cancel ends a slow blocking script so the thread starts", async () => {
    const repo = await repository({
      scripts: [
        { name: "Slow install", id: "slow", command: "sleep 30; echo done > slow.txt", runOnWorktreeCreate: true, async: false },
        { name: "Never", id: "never", command: "echo never > never.txt", runOnWorktreeCreate: true, async: false },
      ],
    });
    const kit = await workspaceKit(repo, true);
    const created = kit.createWorktree("feature-cancel");
    const slow = await kit.setupWhere(running("slow"));
    expect(slow.stages.map((stage) => [stage.id, stage.status])).toEqual([
      ["fetch", "done"], ["checkout", "done"], ["script:slow", "running"], ["script:never", "pending"],
    ]);
    expect(slow.branch).toBe("feature-cancel");
    await kit.scripts("setup-cancel", { setupId: slow.id });
    const worktree = await created;
    expect(existsSync(join(worktree, "slow.txt"))).toBe(false);
    const ended = await kit.setupWhere((setup) => setup.id === slow.id && setup.phase !== "running");
    expect(ended.phase).toBe("cancelled");
    expect(ended.worktree).toBe(worktree);
    expect(ended.stages.slice(2).map((stage) => [stage.status, stage.detail])).toEqual([["skipped", "cancelled"], ["skipped", "cancelled"]]);
    expect(existsSync(join(worktree, "never.txt"))).toBe(false);
    await kit.registry.deactivate("tau.project-scripts");
  });

  it("starts the thread when the user stops waiting, and the blocking script runs on", async () => {
    const repo = await repository({
      scripts: [{ name: "Install", id: "install", command: "sleep 30", runOnWorktreeCreate: true, async: false }],
    });
    const kit = await workspaceKit(repo, true);
    const created = kit.createWorktree("feature-release");
    const setup = await kit.setupWhere(running("install"));
    await kit.scripts("setup-release", { setupId: setup.id });
    await created;
    const current = (await kit.scripts("setups") as UiWorktreeSetup[]).find((entry) => entry.id === setup.id);
    expect(current).toMatchObject({ phase: "running", released: true });
    await kit.scripts("setup-cancel", { setupId: setup.id });
    await kit.setupWhere((entry) => entry.id === setup.id && entry.phase === "cancelled");
    await kit.registry.deactivate("tau.project-scripts");
  });
});
