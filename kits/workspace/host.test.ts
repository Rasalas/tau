import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionServices, HostThread, HostTurnObserver } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { WORKSPACE_HEAD_TOPIC, createWorkspaceHostClient } from "./protocol.js";
import { createWorkspaceHostExtension } from "./host.js";
import { createRemoteWorkHostExtension } from "../remote-work/host.js";
import { readSetupFile } from "./project-approval-host.js";
import { PROJECT_APPROVAL_COMMAND, PROJECT_APPROVAL_EVENT, type ProjectApprovalRequest } from "../_project-file/setup-approval.js";

const directories: string[] = [];
vi.mock("node:os", async (original) => {
  const os = await original<typeof import("node:os")>();
  return { ...os, homedir: vi.fn(os.homedir) };
});

afterEach(async () => {
  vi.mocked(homedir).mockReset();
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
  async function manualWorktree(detached = false) {
    const repo = await workspace();
    const tree = await workspace();
    const stateDir = await workspace();
    const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "base"]);
    git(repo, ["worktree", "add", ...(detached ? ["--detach"] : ["-b", "manual"]), tree, "HEAD"]);
    git(tree, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "unpublished work"]);
    const registry = await activated(repo, { stateDir });
    return { repo, tree, git, registry, input: { path: tree, workspace: repo } };
  }

  it("previews unpublished commits in a worktree created outside Tau", async () => {
    const { registry, input } = await manualWorktree();
    try {
      await expect(registry.invoke("tau.workspace", "worktree-removal-preview", input)).resolves.toMatchObject({
        branch: "manual", ahead: 1, unpushedCommits: 1, ignoredFiles: 0, openThreads: 0,
      });
    } finally { await registry.dispose(); }
  });

  it("keeps an unmerged branch when removing its worktree without a force confirmation", async () => {
    const { repo, tree, git, registry, input } = await manualWorktree();
    const tip = git(tree, ["rev-parse", "HEAD"]);
    try {
      await registry.invoke("tau.workspace", "remove-worktree", input);
      expect(existsSync(tree)).toBe(false);
      expect(git(repo, ["rev-parse", "refs/heads/manual"])).toBe(tip);
    } finally { await registry.dispose(); }
  });

  it("deletes an unmerged branch only after an explicit force confirmation", async () => {
    const { repo, git, registry, input } = await manualWorktree();
    try {
      await registry.invoke("tau.workspace", "remove-worktree", { ...input, forceBranch: true });
      expect(git(repo, ["branch", "--list", "manual"])).toBe("");
    } finally { await registry.dispose(); }
  });

  it("names ignored files and refuses newly added local files without confirmation", async () => {
    const { tree, registry, input } = await manualWorktree();
    try {
      await registry.invoke("tau.workspace", "worktree-removal-preview", input);
      await writeFile(join(tree, ".gitignore"), ".env\n");
      await writeFile(join(tree, ".env"), "local data\n");
      await expect(registry.invoke("tau.workspace", "worktree-removal-preview", input)).resolves.toMatchObject({ dirtyFiles: 1, ignoredFiles: 1 });
      await expect(registry.invoke("tau.workspace", "remove-worktree", input)).rejects.toThrow(/Confirm discarding/u);
      expect(await readFile(join(tree, ".env"), "utf8")).toBe("local data\n");
      await registry.invoke("tau.workspace", "remove-worktree", { ...input, force: true });
      expect(existsSync(tree)).toBe(false);
    } finally { await registry.dispose(); }
  });

  it("protects a detached worktree's exclusive commits and never deletes a branch named detached", async () => {
    const { repo, tree, git, registry, input } = await manualWorktree(true);
    git(repo, ["branch", "detached", "main"]);
    try {
      const preview = await registry.invoke("tau.workspace", "worktree-removal-preview", input);
      expect(preview).toMatchObject({ ahead: 1, unpushedCommits: 1 });
      expect(preview).not.toHaveProperty("branch");
      await expect(registry.invoke("tau.workspace", "remove-worktree", input)).rejects.toThrow(/detached worktree's unpushed commits/u);
      expect(existsSync(tree)).toBe(true);
      await registry.invoke("tau.workspace", "remove-worktree", { ...input, forceBranch: true });
      expect(git(repo, ["branch", "--list", "detached"])).toContain("detached");
    } finally { await registry.dispose(); }
  });

  it("leaves a worktree alone when Git cannot inspect its base", async () => {
    const { tree, git, registry, input } = await manualWorktree();
    git(tree, ["config", "branch.manual.tau-base", "missing-base"]);
    try {
      await expect(registry.invoke("tau.workspace", "worktree-removal-preview", input)).rejects.toThrow();
      await expect(registry.invoke("tau.workspace", "remove-worktree", { ...input, force: true, forceBranch: true })).rejects.toThrow();
      expect(existsSync(tree)).toBe(true);
    } finally { await registry.dispose(); }
  });

  it("ignores the checked-in workspace mode until setup is approved and after commands change", async () => {
    const repo = await workspace();
    const stateDir = await workspace();
    await mkdir(join(repo, ".tau"));
    const save = (command: string) => writeFile(join(repo, ".tau", "project.json"), JSON.stringify({ workspaceMode: "worktree", runOnWorktreeCreate: command }));
    await save("original-command");
    let requested!: (request: ProjectApprovalRequest) => void;
    const request = new Promise<ProjectApprovalRequest>((resolve) => { requested = resolve; });
    const registry = await activated(repo, { stateDir }, (event) => {
      if (event.name === PROJECT_APPROVAL_EVENT && (event.payload as ProjectApprovalRequest[])[0]) requested((event.payload as ProjectApprovalRequest[])[0]);
    });
    try {
      const defaults = () => registry.invoke("tau.workspace", "project-defaults", { workspace: repo });
      await expect(defaults()).resolves.not.toHaveProperty("workspaceMode");
      const approval = registry.invoke("tau.workspace", PROJECT_APPROVAL_COMMAND, { project: repo, fingerprint: (await readSetupFile(repo)).fingerprint });
      await registry.invoke("tau.workspace", "answer-project-approval", { id: (await request).id, approved: true });
      await expect(approval).resolves.toBe(true);
      await expect(defaults()).resolves.toMatchObject({ workspaceMode: "worktree" });
      await save("changed-command");
      await expect(defaults()).resolves.not.toHaveProperty("workspaceMode");
    } finally { await registry.deactivate("tau.workspace"); }
  });

  it("says a private No project folder is projectless in its workspace info", async () => {
    const stateDir = await workspace();
    const folder = await workspace();
    const registry = await activated(folder, { stateDir, knownWorkspacePath: async (id) => id.replace(/^ws1_/u, "") });
    try {
      const info = (workspaceId: string) => registry.invoke("tau.workspace", "workspace-info", { workspace: workspaceId });
      const scratch = await registry.invoke("tau.workspace", "create-scratch") as { workspaceId: string };
      await expect(info(scratch.workspaceId)).resolves.toMatchObject({ isRepo: false, projectless: true });
      await expect(info(folder)).resolves.toMatchObject({ isRepo: false });
      await expect(info(folder)).resolves.not.toHaveProperty("projectless");
    } finally { await registry.deactivate("tau.workspace"); }
  });

  it("protects home secrets when the active workspace changes between authorization and reading", async () => {
    const home = await workspace();
    vi.mocked(homedir).mockReturnValue(home);
    const project = join(home, "repo");
    await mkdir(join(project, ".tau"), { recursive: true });
    await writeFile(join(project, ".tau", "host-token"), "project-fixture");
    await mkdir(join(home, ".tau"));
    await writeFile(join(home, ".tau", "host-token"), "host-secret");
    let switchWorkspace = false;
    let selected = project;
    const registry = await activated(project, { cwd: () => {
      const current = selected;
      if (switchWorkspace) selected = home;
      return current;
    } });
    switchWorkspace = true;
    const phone = { kind: "workbench-client", connection: "phone", pairedClient: "device", readOnly: true } as const;
    try {
      await expect(registry.invoke("tau.workspace", "read-file", { path: ".tau/host-token" }, phone)).resolves.toMatchObject({ text: "project-fixture" });
    } finally { await registry.deactivate("tau.workspace"); }
  });

  it("lets a device read project dotfiles but protects home secrets even with Home as the workspace", async () => {
    const home = await workspace();
    vi.mocked(homedir).mockReturnValue(home);
    const project = join(home, "repo");
    await mkdir(join(project, ".github", "workflows"), { recursive: true });
    await mkdir(join(project, ".tau"));
    await mkdir(join(project, ".git"));
    for (const path of [".github/workflows/ci.yml", ".gitignore", ".env.example", ".tau/project.json"]) await writeFile(join(project, path), "project-fixture");
    await writeFile(join(project, ".git", "config"), "git-secret");
    await mkdir(join(home, ".tau"));
    await writeFile(join(home, ".tau", "host-token"), "host-secret");
    await symlink(join(home, ".tau", "host-token"), join(home, "token-link"));
    for (const name of [".pi", ".ssh", ".config", ".aws", ".private-settings"]) {
      await mkdir(join(home, name));
      await writeFile(join(home, name, "secret"), "host-secret");
    }
    const phone = { kind: "workbench-client", connection: "phone", pairedClient: "device", readOnly: true } as const;
    for (const cwd of [project, home]) {
      const registry = await activated(cwd, { knownWorkspacePath: async (scope) => scope === "ws-repo" ? project : cwd });
      try {
        const prefix = cwd === home ? "repo/" : "";
        for (const path of [".github/workflows/ci.yml", ".gitignore", ".env.example", ".tau/project.json"]) {
          await expect(registry.invoke("tau.workspace", "read-linked-file", { workspace: cwd, path: prefix + path }, phone)).resolves.toMatchObject({ text: "project-fixture" });
          await expect(registry.invoke("tau.workspace", "read-file", { workspace: cwd, path: prefix + path }, phone)).resolves.toMatchObject({ text: "project-fixture" });
        }
        await expect(registry.invoke("tau.workspace", "read-linked-file", { path: join(home, ".tau", "host-token") }, phone)).rejects.toMatchObject({ code: "forbidden" });
        await expect(registry.invoke("tau.workspace", "read-linked-file", { path: prefix + ".git/config" }, phone)).rejects.toMatchObject({ code: "forbidden" });
        if (cwd === home) {
          await expect(registry.invoke("tau.workspace", "read-file", { workspace: "ws-repo", path: ".github/workflows/ci.yml" }, phone)).resolves.toMatchObject({ text: "project-fixture" });
          for (const path of ["~/.tau/host-token", "token-link", ".pi/secret", ".ssh/secret", ".config/secret", ".aws/secret", ".private-settings/secret"]) {
            await expect(registry.invoke("tau.workspace", "read-linked-file", { workspace: cwd, path }, phone)).rejects.toMatchObject({ code: "forbidden" });
          }
          await expect(registry.invoke("tau.workspace", "read-linked-file", { workspace: cwd, path: ".tau/host-token" }, { kind: "workbench-client" })).resolves.toMatchObject({ text: "host-secret" });
        }
        const nodes = await registry.invoke("tau.workspace", "file-tree", { workspace: cwd }, phone);
        expect(nodes).toEqual(expect.arrayContaining([{ name: cwd === home ? "repo" : ".github", path: cwd === home ? "repo" : ".github", kind: "directory" }]));
        expect(nodes).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: cwd === home ? ".tau" : ".git" })]));
      } finally { await registry.deactivate("tau.workspace"); }
    }
  });

  it("refuses a paired read-only device the host token while the owner can open the link", async () => {
    const root = await workspace();
    const project = join(root, "project");
    const token = join(root, ".tau", "host-token");
    await mkdir(project);
    await mkdir(join(root, ".tau"));
    await writeFile(token, "fixture-token");
    const registry = await activated(project, { knownWorkspacePath: async () => project });
    const input = { workspace: "ws-project", path: token };
    const phone = { kind: "workbench-client", connection: "phone", pairedClient: "device", readOnly: true } as const;
    try {
      await expect(registry.invoke("tau.workspace", "read-linked-file", input, phone)).rejects.toMatchObject({ code: "forbidden" });
      await expect(registry.invoke("tau.workspace", "read-linked-file", input, { kind: "workbench-client" })).resolves.toMatchObject({ text: "fixture-token" });
    } finally {
      await registry.deactivate("tau.workspace");
    }
  });

  it("checks every registered workspace read command before it can read an outside path", async () => {
    const root = await workspace();
    const project = join(root, "project");
    const outside = join(root, "outside.txt");
    await mkdir(project);
    await writeFile(outside, "outside");
    const registry = await activated(project, { knownWorkspacePath: async () => project });
    const phone = { kind: "workbench-client", connection: "phone", pairedClient: "device", readOnly: true } as const;
    try {
      const reads = registry.summaries().find((entry) => entry.id === "tau.workspace")!.readCommands!;
      for (const command of reads) {
        await expect(registry.invoke("tau.workspace", command, { workspace: "ws-project", path: outside }, phone), command).rejects.toMatchObject({ code: "forbidden" });
      }
      await mkdir(join(project, "visible-folder"));
      for (const path of [undefined, "", "   "]) {
        await expect(registry.invoke("tau.workspace", "list-directories", { path }, phone)).resolves.toMatchObject({ path: project, directories: [{ name: "visible-folder" }] });
      }
      await writeFile(join(project, "visible.txt"), "visible");
      await expect(registry.invoke("tau.workspace", "read-linked-file", { workspace: "ws-project", path: "visible.txt" }, phone)).resolves.toMatchObject({ text: "visible" });
    } finally {
      await registry.deactivate("tau.workspace");
    }
  });

  it.each(["pi", "claude-code", "machine"])("restores the recorded worktree before a %s turn only when the thread runs locally", async (backendKind) => {
    const root = await workspace();
    const repo = join(root, "repo");
    const active = join(root, "other-project");
    await mkdir(repo);
    await mkdir(active);
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { encoding: "utf8", stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("commit", "-qm", "initial", "--allow-empty");
    const observers: HostTurnObserver[] = [];
    let path = "";
    const registry = await activated(active, {
      stateDir: join(root, "state"),
      thread: () => ({ sessionId: "old-thread", cwd: path, backendKind } as HostThread),
      registerTurnObserver: (observer) => { observers.push(observer); return () => undefined; },
    });
    try {
      const created = await registry.invoke("tau.workspace", "create-worktree", { workspace: repo, branch: "saved-thread", startFromOrigin: false }) as { path: string };
      path = created.path;
      await rm(path, { recursive: true });
      for (const observer of observers) await observer.prepare?.("old-thread", "next-turn");
      expect(existsSync(join(path, ".git"))).toBe(backendKind !== "machine");
      if (backendKind !== "machine") {
        expect(execFileSync("git", ["-C", path, "branch", "--show-current"], { encoding: "utf8" }).trim()).toBe("saved-thread");
      }
      expect(git("branch", "--show-current").trim()).toBe("main");
    } finally {
      await registry.deactivate("tau.workspace");
    }
  });

  it("reads visualization fragments from the named workspace and refuses unknown origins", async () => {
    const active = await workspace();
    const origin = await workspace();
    await writeFile(join(active, "chart.html"), "wrong active workspace");
    await writeFile(join(origin, "chart.html"), "<svg>thread origin</svg>");
    const host = await client(active, { knownWorkspacePath: async (id) => {
      if (id !== "thread-workspace") throw new Error("Unknown workspace");
      return origin;
    } });
    expect(await host.readVisualization("chart.html", "thread-workspace")).toEqual({ html: "<svg>thread origin</svg>" });
    await expect(host.readVisualization("chart.html", "unknown")).rejects.toThrow("Unknown workspace");
    await expect(host.readVisualization(join(origin, "chart.html"), "thread-workspace")).rejects.toThrow("inside the workspace");
  });

  it("issue 12 reads dot-directory images and Markdown from the named workspace, not active cwd", async () => {
    const cwd = await workspace();
    const origin = await workspace();
    const images = [".tau-dev/dictation-preview/recording-detail.png", ".tau-dev/dictation-preview/inserted-detail.png"];
    const document = ".scratch/mobile-transcript-images/issues/01-render-workspace-screenshots-on-mobile.md";
    await mkdir(join(origin, ".tau-dev/dictation-preview"), { recursive: true });
    await mkdir(join(origin, ".scratch/mobile-transcript-images/issues"), { recursive: true });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
    for (const path of images) await writeFile(join(origin, path), png);
    await writeFile(join(origin, document), "Issue 12 readable workspace document fixture");
    const host = await client(cwd, { knownWorkspacePath: async (id) => {
      if (id !== "ws-origin") throw new Error("Unknown workspace");
      return origin;
    } });
    for (const path of images) expect(await host.readFile(path, "ws-origin")).toMatchObject({ kind: "image", dataUrl: `data:image/png;base64,${png.toString("base64")}` });
    expect(await host.readFile(document, "ws-origin")).toMatchObject({ kind: "text", text: "Issue 12 readable workspace document fixture" });
    await expect(host.readFile(document, "unknown-workspace")).rejects.toThrow("Unknown workspace");
    await expect(host.readFile("../outside.md", "ws-origin")).rejects.toThrow();
    await expect(host.readFile("/etc/passwd", "ws-origin")).rejects.toThrow();
    await expect(host.readFile(".scratch/missing.md", "ws-origin")).rejects.toThrow();
  });
  it("reads linked files outside the transcript workspace on its host without widening workspace writes", async () => {
    const root = await workspace();
    const origin = join(root, "project with spaces");
    const cwd = join(root, "active", "project with spaces");
    const linked = "../docs/intern/lena-becker-de/mailentwurf-uebergabe.md";
    await mkdir(origin, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await mkdir(join(root, "docs/intern/lena-becker-de"), { recursive: true });
    const absolute = join(root, "docs/intern/lena-becker-de/mailentwurf-uebergabe.md");
    await writeFile(absolute, "outside the project\n");
    const registry = await activated(cwd, { knownWorkspacePath: async (id) => {
      if (id !== "ws-origin") throw new Error("Unknown workspace");
      return origin;
    } });
    const read = (path: string, workspaceId = "ws-origin") => registry.invoke("tau.workspace", "read-linked-file", { path, workspace: workspaceId });
    for (const path of [linked, absolute]) {
      await expect(read(path)).resolves.toMatchObject({ kind: "text", text: "outside the project\n" });
    }
    await expect(read(linked, "unknown")).rejects.toThrow("Unknown workspace");
    await expect(read("")).rejects.toThrow();
    await expect(read("https://example.invalid/file.md")).rejects.toThrow();
    await expect(registry.invoke("tau.workspace", "read-linked-file", { path: absolute })).rejects.toThrow();
    await expect(registry.invoke("tau.workspace", "write-file", { relPath: linked, text: "overwritten", workspace: "ws-origin" })).rejects.toThrow("inside the workspace");
    expect(await readFile(absolute, "utf8")).toBe("outside the project\n");
  });
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

  it("admits its new worktree and copies selected local files before the thread starts", async () => {
    const cwd = await workspace();
    const worktrees = await workspace();
    const git = (...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=Tau", "-c", "user.email=tau@example.invalid", ...args], { stdio: "ignore" });
    git("init", "-b", "main");
    await writeFile(join(cwd, "README.md"), "# fixture\n");
    await writeFile(join(cwd, ".gitignore"), ".env\n");
    await writeFile(join(cwd, ".env"), "TOKEN=local-fixture\n");
    git("add", "README.md", ".gitignore");
    git("commit", "-m", "fixture");
    const admitWorkspace = vi.fn((path: string) => ({ workspaceId: `admitted_${path}`, displayPath: path }));
    vi.stubEnv("TAU_WORKTREES_DIR", worktrees);
    try {
      const registry = await activated(cwd, { admitWorkspace, stateDir: join(cwd, "state") });
      await registry.activate(createRemoteWorkHostExtension({ root: join(cwd, "remote-work") }));
      await registry.invoke("tau.remote-work", "set-ignored-files", { cwd, paths: [".env"] });
      const kit = createWorkspaceHostClient((command, input) => registry.invoke("tau.workspace", command, input));
      const created = await kit.createWorktree("feature", { startFromOrigin: false });
      expect(admitWorkspace).toHaveBeenCalledWith(created.displayPath);
      expect(created.workspaceId).toBe(`admitted_${created.displayPath}`);
      expect(created.baseCommit).toBe(execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
      expect(created.displayPath.startsWith(worktrees)).toBe(true);
      const next = await kit.createWorktree("feature", { startFromOrigin: false, uniqueBranch: true });
      expect(next.displayPath).not.toBe(created.displayPath);
      expect(execFileSync("git", ["-C", next.displayPath, "branch", "--show-current"], { encoding: "utf8" }).trim()).toBe("feature-2");
      expect(execFileSync("git", ["-C", cwd, "config", "branch.feature-2.tau-base"], { encoding: "utf8" }).trim()).toBe("main");
      expect(await readFile(join(created.displayPath, ".env"), "utf8")).toBe("TOKEN=local-fixture\n");
      expect(await readFile(join(cwd, ".env"), "utf8")).toBe("TOKEN=local-fixture\n");
      await registry.deactivate("tau.remote-work");
      // Disabling the optional kit must not disable ordinary Git worktrees.
      const plain = await kit.createWorktree("without-remote-work", { startFromOrigin: false });
      await expect(readFile(join(plain.displayPath, ".env"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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

it("streams linked video from its named workspace with seek ranges", async () => {
  const active = await workspace();
  const origin = await workspace();
  await writeFile(join(origin, "clip.mp4"), "0123456789");
  const handlers: Array<(request: Request) => Promise<Response>> = [];
  const registry = await activated(active, {
    knownWorkspacePath: async (id) => { if (id !== "origin") throw new Error("Unknown workspace"); return origin; },
    browserResources: { publish: (handler) => { handlers.push(handler); return "/resources/clip"; }, release: () => undefined, publishVisualization: () => "", publishFrame: () => "" },
  });
  expect(await registry.invoke("tau.workspace", "publish-linked-media", { path: "clip.mp4", workspace: "origin" })).toEqual({ path: "/resources/clip", mimeType: "video/mp4" });
  const response = await handlers[0]!(new Request("https://host/resources/clip", { headers: { Range: "bytes=2-5" } }));
  expect(response.status).toBe(206);
  expect(await response.text()).toBe("2345");
  await expect(registry.invoke("tau.workspace", "publish-linked-media", { path: "clip.mp4", workspace: "unknown" })).rejects.toThrow("Unknown workspace");
});
