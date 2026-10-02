import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionServices } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { WORKSPACE_HEAD_TOPIC, createWorkspaceHostClient } from "./protocol.js";
import { createWorkspaceHostExtension } from "./host.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  // Git reports canonical paths; on macOS /var is a symlink to /private/var.
  const path = await realpath(await mkdtemp(join(tmpdir(), "tau-workspace-kit-")));
  directories.push(path);
  return path;
}

async function activated(cwd: string, overrides: Partial<HostExtensionServices> = {}, publish?: (event: PublishedKitEvent) => void) {
  const services: Partial<HostExtensionServices> = {
    cwd: () => cwd,
    openWorkspace: async () => ({ version: 1 as const, updates: [] }),
    knownWorkspacePath: async (path) => path,
    workspaceRef: (path: string) => ({ workspaceId: `ws1_${path}`, displayPath: path }),
    admitWorkspace: (path: string) => ({ workspaceId: `ws1_${path}`, displayPath: path }),
    projectName: async () => "project",
    rememberProjectName: () => undefined,
    pickDirectory: async () => undefined,
    runtimeOwner: () => "tau" as const,
    thread: () => undefined,
    setThreadTitle: async () => undefined,
    attachedRuntime: () => undefined,
    describeProjects: () => () => undefined,
    noteSubprocess: () => undefined,
    findCommand: () => undefined,
    refreshExtensionPackages: async () => undefined,
    sessions: {
      list: async () => [],
      open: () => { throw new Error("no sessions in this test"); },
      prepare: async () => { throw new Error("no sessions in this test"); },
      start: async () => { throw new Error("no threads in this test"); },
      exclusive: (work) => work(),
      remove: async () => undefined, restore: async () => undefined, trash: async () => [], purge: async () => undefined,
      refreshIndex: async () => ({ version: 1 as const, type: "thread-index" as const, index: { projects: [], sessions: [] } }),
    },
    clients: { observe: () => () => undefined, count: () => 1 },
    registerThreadLifecycle: () => () => undefined,
    registerTurnObserver: () => () => undefined,
    pinTranscriptEntries: () => () => undefined,
    decorateUiPrompt: () => () => undefined,
    registerRuntimeExtension: () => () => undefined,
    setPermissionLevel: () => undefined,
    registerRuntimeBackend: () => () => undefined,
    presentUi: () => () => undefined,
    callClient: async () => { throw new Error("no window half in this test"); },
    ...overrides,
  };
  return activateHostKit(createWorkspaceHostExtension(), services, publish);
}

async function client(cwd: string, overrides: Partial<HostExtensionServices> = {}) {
  const registry = await activated(cwd, overrides);
  return createWorkspaceHostClient((command, input) => registry.invoke("tau.workspace", command, input));
}

describe("Workspace Kit host extension", () => {
  it("stages and changes branches in a named workspace while leaving the active workspace alone", async () => {
    const cwd = await workspace();
    const target = await workspace();
    const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=Tau", "-c", "user.email=tau@example.invalid", ...args], { encoding: "utf8" });
    for (const root of [cwd, target]) {
      git(root, "init", "-q", "-b", "main");
      await writeFile(join(root, "a.txt"), "initial");
      git(root, "add", "a.txt");
      git(root, "commit", "-q", "-m", "first");
      await writeFile(join(root, "a.txt"), "changed");
    }
    const openWorkspace = vi.fn(async () => ({ version: 1 as const, updates: [] }));
    const host = await client(cwd, { knownWorkspacePath: async (id) => { expect(id).toBe("ws1_other"); return target; }, openWorkspace });
    await host.stageFile("a.txt", "ws1_other");
    expect(git(target, "diff", "--cached", "--name-only").trim()).toBe("a.txt");
    expect(git(cwd, "diff", "--cached", "--name-only").trim()).toBe("");
    await host.unstageFile("a.txt", "ws1_other");
    expect(git(target, "diff", "--cached", "--name-only").trim()).toBe("");
    await host.stageAll("ws1_other");
    expect(git(target, "diff", "--cached", "--name-only").trim()).toBe("a.txt");
    await host.unstageFile("a.txt", "ws1_other");
    await host.revertFile("a.txt", "ws1_other");
    expect(git(target, "diff", "--name-only").trim()).toBe("");
    await expect(host.createBranch("feature", "ws1_other")).resolves.toEqual({ version: 1, updates: [] });
    expect(git(target, "branch", "--show-current").trim()).toBe("feature");
    await expect(host.switchRef("main", "ws1_other")).resolves.toEqual({ version: 1, updates: [] });
    expect(git(target, "branch", "--show-current").trim()).toBe("main");
    expect(git(cwd, "branch", "--show-current").trim()).toBe("main");
    expect(openWorkspace).not.toHaveBeenCalled();
  });


  it("tells clients when HEAD moves outside Tau, and answers the new branch at once", async () => {
    const cwd = await workspace();
    const git = (...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=Tau", "-c", "user.email=tau@example.invalid", ...args], { stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "first");
    git("branch", "feature");
    // The test setup turns every watch off.
    vi.stubEnv("TAU_NO_WATCH", "0");
    const events: PublishedKitEvent[] = [];
    const registry = await activated(cwd, {}, (event) => events.push(event));
    const host = createWorkspaceHostClient((command, input) => registry.invoke("tau.workspace", command, input));
    const before = await host.getWorkspaceInfo();
    expect(before.branch).toBe("main");

    git("checkout", "-q", "feature");
    await vi.waitFor(() => expect(events.some((event) => event.name === "head-changed")).toBe(true), { timeout: 5_000 });
    expect(events.find((event) => event.name === "head-changed")).toMatchObject({ topic: WORKSPACE_HEAD_TOPIC, payload: { root: before.root } });
    // The 30 s cache would otherwise still answer "main".
    expect((await host.getWorkspaceInfo()).branch).toBe("feature");
    await registry.deactivate("tau.workspace");
    vi.unstubAllEnvs();
  });

  it("pulls the default branch only when the host's own config turns that on", async () => {
    const cwd = await workspace();
    const git = (...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=Tau", "-c", "user.email=tau@example.invalid", ...args], { stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "first");
    let options: Record<string, boolean> = {};
    const settings = (async (_id: string, project?: string) => ({ options: project === cwd ? options : {}, values: {} })) as never;
    const kit = await client(cwd, { settings });
    // A client whose own copy still says "on" asks; the host's config says off.
    await expect(kit.autoPull(cwd)).resolves.toEqual([]);
    options = { "auto-pull-default-branch": true };
    await expect(kit.autoPull(cwd)).resolves.toContainEqual({ checkout: "workspace", status: "skipped", reason: "no-upstream" });
  });

  it("waits on the folder dialog as long as the user does", async () => {
    const registry = await activated(await workspace());
    expect(registry.longCommands()).toContain("tau.workspace/pick-folder");
  });

  it("shows the .scratch directory and lets the viewer load its contents", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, ".scratch", "feature", "issues"), { recursive: true });
    await writeFile(join(cwd, ".scratch", "feature", "spec.md"), "# Spec\n");
    await mkdir(join(cwd, ".git"));
    const kit = await client(cwd);

    const root = await kit.getFileTree();
    expect(root.map((node) => node.name)).toContain(".scratch");
    expect(root.map((node) => node.name)).not.toContain(".git");

    const scratch = await kit.getFileTree(".scratch");
    expect(scratch).toEqual([expect.objectContaining({ name: "feature", kind: "directory", path: ".scratch/feature" })]);

    const feature = await kit.getFileTree(".scratch/feature");
    expect(feature.map((node) => node.path)).toEqual([".scratch/feature/issues", ".scratch/feature/spec.md"]);
  });

  it("reads files inside the workspace and refuses anything that leaves it", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "README.md"), "hello\n");
    const kit = await client(cwd);
    await expect(kit.readFile("README.md")).resolves.toMatchObject({ kind: "text", text: "hello\n" });
    // A relative reference cannot escape, and an absolute one is not a reference at all.
    await expect(kit.readFile("../outside.txt")).rejects.toThrow("Name a file by its path inside the workspace.");
    await expect(kit.readFile(join(cwd, "README.md"))).rejects.toThrow("Name a file by its path inside the workspace.");
  });

  it("reads the project a caller names, which a draft's may be, and refuses one the host does not know", async () => {
    const hostProject = await workspace();
    const draftProject = await workspace();
    await mkdir(join(draftProject, "src"));
    await writeFile(join(draftProject, "src", "only-in-b.ts"), "export const b = 1;\n");
    const kit = await client(hostProject, {
      knownWorkspacePath: async (named) => {
        if (named === `ws1_${draftProject}`) return draftProject;
        throw new Error("Workspace is not a known Tau project.");
      },
    });

    await expect(kit.readFile("src/only-in-b.ts")).rejects.toThrow(/ENOENT/u);
    await expect(kit.readFile("src/only-in-b.ts", `ws1_${draftProject}`)).resolves.toMatchObject({ kind: "text", text: "export const b = 1;\n" });
    await expect(kit.getFileTree(undefined, `ws1_${draftProject}`)).resolves.toEqual([expect.objectContaining({ name: "src", kind: "directory" })]);
    await expect(kit.getFileTree("src", `ws1_${draftProject}`)).resolves.toEqual([expect.objectContaining({ path: "src/only-in-b.ts" })]);
    await expect(kit.readFile("src/only-in-b.ts", "ws1_gone")).rejects.toThrow("Workspace is not a known Tau project.");
  });

  it("lists changes, stats and writes in the project a caller names, leaving the host's own alone", async () => {
    const repo = async (text: string) => {
      const cwd = await workspace();
      const git = (...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=Tau", "-c", "user.email=tau@example.invalid", "-c", "commit.gpgSign=false", ...args], { stdio: "ignore" });
      git("init", "-q", "-b", "main");
      await mkdir(join(cwd, "src"));
      await writeFile(join(cwd, "src", "same.ts"), text);
      git("add", ".");
      git("commit", "-q", "-m", "fixture");
      return cwd;
    };
    const hostProject = await repo("export const a = 1;\n");
    const draftProject = await repo("export const b = 1;\n");
    const registry = await activated(hostProject, {
      knownWorkspacePath: async (named) => {
        if (named === `ws1_${draftProject}`) return draftProject;
        throw new Error("Workspace is not a known Tau project.");
      },
    });
    const invoke = (command: string, input: unknown) => registry.invoke("tau.workspace", command, input);
    const kit = createWorkspaceHostClient(invoke);

    const stat = await invoke("file-stat", { relPath: "src/same.ts", workspace: `ws1_${draftProject}` }) as { mtimeMs: number };
    await expect(invoke("write-file", { relPath: "src/same.ts", text: "export const b = 2;\n", expectedMtimeMs: stat.mtimeMs, workspace: `ws1_${draftProject}` }))
      .resolves.toMatchObject({ status: "written" });

    await expect(kit.getChanges(undefined, `ws1_${draftProject}`)).resolves.toMatchObject({ files: [expect.objectContaining({ path: "src/same.ts" })] });
    await expect(kit.getChanges()).resolves.toMatchObject({ files: [] });
    await expect(kit.getChanges(undefined, "ws1_gone")).rejects.toThrow("Workspace is not a known Tau project.");
  });

  it("refuses to browse a tree outside the workspace", async () => {
    const cwd = await workspace();
    const kit = await client(cwd);
    await expect(kit.getFileTree("/")).rejects.toThrow("Name a file by its path inside the workspace.");
    await expect(kit.getFileTree("../..")).rejects.toThrow("Name a file by its path inside the workspace.");
  });

  it("validates command input before touching the workspace", async () => {
    const cwd = await workspace();
    const kit = await client(cwd);
    await expect(kit.readFile("")).rejects.toThrow("Name a file by its path inside the workspace.");
    await expect(kit.openInEditor("")).rejects.toThrow('Workspace command needs "editorId".');
  });

  it("admits the worktree it creates, so the draft that moves there can ask about it at once", async () => {
    const cwd = await workspace();
    const worktrees = await workspace();
    const git = (...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=Tau", "-c", "user.email=tau@example.invalid", ...args], { stdio: "ignore" });
    git("init", "-b", "main");
    await writeFile(join(cwd, "README.md"), "# fixture\n");
    git("add", "README.md");
    git("commit", "-m", "fixture");
    const admitWorkspace = vi.fn((path: string) => ({ workspaceId: `admitted_${path}`, displayPath: path }));
    vi.stubEnv("TAU_WORKTREES_DIR", worktrees);
    try {
      const kit = await client(cwd, { admitWorkspace });
      const created = await kit.createWorktree("feature", { startFromOrigin: false });
      expect(admitWorkspace).toHaveBeenCalledWith(created.displayPath);
      expect(created.workspaceId).toBe(`admitted_${created.displayPath}`);
      expect(created.baseCommit).toBe(execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
      expect(created.displayPath.startsWith(worktrees)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("gives a fork a branch and worktree of its own, with the checkout's files as they are now or HEAD's alone", async () => {
    const cwd = await workspace();
    const worktrees = await workspace();
    const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=Tau", "-c", "user.email=tau@example.invalid", ...args], { encoding: "utf8" }).trim();
    git(cwd, "init", "-q", "-b", "main");
    await writeFile(join(cwd, "README.md"), "# fixture\n");
    git(cwd, "add", "README.md");
    git(cwd, "commit", "-qm", "fixture");
    git(cwd, "switch", "-qc", "feat/frost");
    git(cwd, "config", "branch.feat/frost.tau-base", "main");
    await writeFile(join(cwd, "README.md"), "# changed\n");
    await writeFile(join(cwd, "frost.txt"), "one\n");
    vi.stubEnv("TAU_WORKTREES_DIR", worktrees);
    try {
      const kit = await client(cwd);
      const copy = await kit.forkWorktree({ branch: "feat/frost-2", now: true });
      expect(copy.copied).toBe(true);
      expect(git(copy.path, "branch", "--show-current")).toBe("feat/frost-2");
      expect(await readFile(join(copy.path, "frost.txt"), "utf8")).toBe("one\n");
      // Uncommitted there as here, and merging where the source merges.
      expect(git(copy.path, "status", "--porcelain")).toBe("M README.md\n?? frost.txt");
      expect(git(cwd, "config", "branch.feat/frost-2.tau-base")).toBe("main");
      expect(git(cwd, "status", "--porcelain")).toBe("M README.md\n?? frost.txt");

      const bare = await kit.forkWorktree({ branch: "feat/frost-3" });
      expect(bare.copied).toBe(false);
      expect(git(bare.path, "status", "--porcelain")).toBe("");
      await expect(kit.forkWorktree({ branch: "feat/frost-2" })).rejects.toThrow(/already exists/u);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("writes a drift branch and merges it only for Servers Kit", async () => {
    const cwd = await workspace();
    const git = (...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=Tau", "-c", "user.email=tau@example.invalid", "-c", "commit.gpgSign=false", ...args], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    // The kit's own git calls take the repository's identity, as they would the user's.
    git("config", "user.name", "Tau");
    git("config", "user.email", "tau@example.invalid");
    git("config", "commit.gpgSign", "false");
    await writeFile(join(cwd, "index.php"), "old\n");
    git("add", "index.php");
    git("commit", "-q", "-m", "first");
    const registry = await activated(cwd);
    const asKit = async (id: string, command: string, input: unknown) => {
      let outcome: unknown;
      await registry.activate({ id, name: id, activate: async (context) => {
        outcome = await context.invokeHostExtension("tau.workspace", command, input).catch((error: unknown) => error);
      } });
      return outcome;
    };
    const input = { workspace: cwd, branch: "server-drift/2026-09-25", message: "drift", unique: true, files: [{ path: "index.php", content: Buffer.from("new\n").toString("base64") }] };
    expect(String(await asKit("acme.other", "commit-files-to-branch", input))).toMatch(/unauthori[sz]ed|not allowed|grant/iu);
    await expect(asKit("tau.servers", "commit-files-to-branch", input)).resolves.toMatchObject({ branch: "server-drift/2026-09-25", changed: ["index.php"] });
    expect(registry.longCommands()).toEqual(expect.arrayContaining(["tau.workspace/commit-files-to-branch", "tau.workspace/merge-branch"]));
    await expect(asKit("tau.servers", "merge-branch", { workspace: cwd, branch: "../x" })).resolves.toBeInstanceOf(Error);
    await expect(asKit("tau.servers", "merge-branch", { workspace: cwd, branch: "server-drift/2026-09-25" })).resolves.toMatchObject({ alreadyMerged: false, into: "main" });
  });

  it("answers folder browsing with an identity for the folder a client would keep", async () => {
    const cwd = await workspace();
    const kit = await client(cwd);
    const listing = await kit.listDirectories(cwd);
    expect(listing.workspace.workspaceId).toMatch(/^ws1_/u);
    expect(listing.workspace.displayPath).toBe(listing.path);
  });
});
