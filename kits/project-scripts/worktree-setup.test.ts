import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostExtensionServices } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
// Test only: the two kits meet through the host registry, as they do in the app.
import { createWorkspaceHostExtension } from "../workspace/host.js";
import { createProjectScriptsHostExtension } from "./host.js";

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
  const registry = await activateHostKit(createWorkspaceHostExtension(), services);
  if (withProjectScripts) await registry.activate(createProjectScriptsHostExtension({ watch: false }));
  const createWorktree = async (branch: string) => {
    const ref = await registry.invoke("tau.workspace", "create-worktree", { branch, workspace: repo }) as { displayPath: string };
    return ref.displayPath;
  };
  return { registry, logs, createWorktree };
}

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
});
