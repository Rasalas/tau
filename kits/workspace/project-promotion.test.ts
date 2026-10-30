import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionServices, HostThread, UiProject, UiSession } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { isScratchWorkspace, promotionFile, readPromotedProject } from "./project-starts.js";
import { promotionName, registerProjectPromotion } from "./project-promotion.js";

const roots: string[] = [];
const stops: Array<() => Promise<void>> = [];
let executable = "git";
vi.mock("tau/host-extension", async (original) => ({ ...await original<Record<string, unknown>>(), gitExecutable: () => executable }));
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  executable = "git";
});

async function fixture(backendKind = "codex") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tau-project-promotion-")));
  roots.push(root);
  const state = join(root, "tau.workspace");
  const path = join(state, "scratch", "4dc4b790-02ab-42da-a130-a4f972df1d30");
  await mkdir(path, { recursive: true });
  const sessionFile = join(state, "saved-session.jsonl");
  const messages = '{"type":"session","id":"thread","cwd":' + JSON.stringify(path) + '}\n{"role":"user","text":"Keep my work"}\n';
  await writeFile(sessionFile, messages);
  await writeFile(join(path, "notes.txt"), "untouched work\n");
  const row: UiSession = { id: "thread", path: sessionFile, title: "My research", projectName: "No project", projectPath: path, workspaceId: "ws1_private", projectless: true, messageCount: 2, modifiedAt: 1, backendKind };
  const rows = [row];
  const projects: UiProject[] = [];
  let running = false;
  const abort = vi.fn();
  const live = { sessionId: row.id, cwd: path, backendKind, isStreaming: () => running, sessionName: () => row.title, abort, persist: vi.fn() } as unknown as HostThread;
  const refreshProject = vi.fn(async (_path: string) => undefined);
  const openWorkspace = vi.fn();
  const start = vi.fn();
  const prepare = vi.fn();
  const shell = () => {
    const promoted = readPromotedProject(state, path);
    return rows.map((entry) => entry.projectPath === path ? { ...entry, projectName: promoted?.name ?? "No project", projectless: !promoted } : entry);
  };
  const services = {
    stateDir: root,
    knownWorkspacePath: async (id: string) => { if (id === "ws1_private" || id === path) return path; throw new Error("unknown workspace"); },
    workspaceRef: (folder: string) => ({ workspaceId: "ws1_private", displayPath: folder }),
    refreshProject, openWorkspace,
    thread: (id?: string) => id === row.id ? live : undefined,
    sessions: { exclusive: (work: () => Promise<unknown>) => work(), refreshIndex: vi.fn(async () => ({ version: 1, type: "thread-index", index: { projects, sessions: shell(), complete: true } })), start, prepare },
  } as unknown as Partial<HostExtensionServices>;
  const activate = async () => {
    const registry = await activateHostKit({ id: "tau.workspace", name: "Workspace", permissions: ["workspace:read", "workspace:write", "sessions"], activate: (context) => registerProjectPromotion(context, { invalidate: vi.fn(), running: async () => running ? [row.id] : [] }) }, services);
    stops.push(() => registry.dispose());
    return registry;
  };
  const registry = await activate();
  const input = { workspace: "ws1_private", sessionId: row.id, name: "Research", git: false };
  return { state, path, row, rows, projects, sessionFile, messages, live, abort, refreshProject, openWorkspace, start, prepare, registry, activate, input, run: () => { running = true; } };
}

describe("project promotion", () => {
  it.each(["pi", "claude-code", "codex", "opencode"])("preserves %s thread, session, messages, workspace and runtime owner even while running", async (kind) => {
    const f = await fixture(kind);
    f.run();
    const result = await f.registry.invoke("tau.workspace", "promote-scratch", f.input);
    expect(result).toEqual({ workspace: { workspaceId: "ws1_private", displayPath: f.path }, name: "Research" });
    expect(f.live.backendKind).toBe(kind);
    expect(f.live.sessionId).toBe(f.row.id);
    expect(f.live.cwd).toBe(f.path);
    expect(await readFile(f.sessionFile, "utf8")).toBe(f.messages);
    expect(await readFile(join(f.path, "notes.txt"), "utf8")).toBe("untouched work\n");
    expect(f.openWorkspace).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
    expect(f.refreshProject).toHaveBeenCalledWith(f.path);
    expect(isScratchWorkspace(f.state, f.path)).toBe(false);
    expect((await stat(promotionFile(f.state, f.path))).mode & 0o777).toBe(0o600);
    expect(f.row.title).toBe("My research");
  });

  it("retains registration after restarting the extension and retrying a lost response", async () => {
    const f = await fixture();
    await f.registry.invoke("tau.workspace", "promote-scratch", f.input);
    const registry = await f.activate();
    await expect(registry.invoke("tau.workspace", "promotion-info", f.input)).resolves.toMatchObject({ promoted: true, title: "My research", workspace: { workspaceId: "ws1_private" } });
    await expect(registry.invoke("tau.workspace", "promote-scratch", f.input)).resolves.toMatchObject({ name: "Research" });
    expect(f.refreshProject).toHaveBeenCalledTimes(2);
    expect(readPromotedProject(f.state, f.path)?.name).toBe("Research");
  });

  it("serializes simultaneous device requests into one registration", async () => {
    const f = await fixture();
    const results = await Promise.all([
      f.registry.invoke("tau.workspace", "promote-scratch", f.input),
      f.registry.invoke("tau.workspace", "promote-scratch", f.input),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(f.refreshProject).toHaveBeenCalledTimes(2);
  });

  it("reserves promoted names even when the project has no threads and aged out of history", async () => {
    const f = await fixture();
    const other = join(f.state, "scratch", "c91b1c15-9057-40da-b03e-d994ca617304");
    await mkdir(other); await mkdir(join(f.state, "promoted-projects"));
    await writeFile(promotionFile(f.state, other), JSON.stringify({ version: 1, path: other, name: "Research" }));
    await expect(f.registry.invoke("tau.workspace", "promote-scratch", f.input)).rejects.toThrow('A project named "Research" already exists.');
    expect(isScratchWorkspace(f.state, f.path)).toBe(true);
    expect(f.refreshProject).not.toHaveBeenCalled();
  });

  it("allows another machine to have a project with the same name", async () => {
    const f = await fixture();
    f.rows.push({ ...f.row, id: "rex~thread", workspaceId: "ws1_rex", projectName: "Research", projectless: false, backendKind: "machine", projectPath: "/home/rex/research" });
    f.projects.push({ path: "/home/rex/research", workspaceId: "ws1_rex", name: "Research", lastOpenedAt: 1 });
    await expect(f.registry.invoke("tau.workspace", "promote-scratch", f.input)).resolves.toMatchObject({ name: "Research" });
  });

  it("counts all runtimes sharing the folder and refuses another thread's identity", async () => {
    const f = await fixture();
    f.rows.push({ ...f.row, id: "claude", backendKind: "claude-code" }, { ...f.row, id: "pi", backendKind: "pi" }, { ...f.row, id: "proxy", backendKind: "machine" });
    await expect(f.registry.invoke("tau.workspace", "promotion-info", f.input)).resolves.toMatchObject({ otherThreads: 2 });
    await expect(f.registry.invoke("tau.workspace", "promote-scratch", { ...f.input, sessionId: "missing" })).rejects.toThrow("does not belong");
    await expect(f.registry.invoke("tau.workspace", "promote-scratch", { ...f.input, sessionId: "proxy" })).rejects.toThrow("does not belong");
    expect(readPromotedProject(f.state, f.path)).toBeUndefined();
  });

  it("does not mutate on a read or a Read-only caller's promotion request", async () => {
    const f = await fixture();
    const principal = { kind: "workbench-client", connection: "phone", pairedClient: "device", readOnly: true } as const;
    await f.registry.invoke("tau.workspace", "promotion-info", f.input, principal);
    await expect(f.registry.invoke("tau.workspace", "promote-scratch", f.input, principal)).rejects.toMatchObject({ code: "forbidden" });
    expect(f.refreshProject).not.toHaveBeenCalled();
    await expect(stat(join(f.path, "t3.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses duplicate names and a missing source folder before any mutation", async () => {
    const f = await fixture();
    const other = join(f.state, "another-project"); await mkdir(other);
    f.rows.push({ ...f.row, id: "other", projectless: false, projectName: "RESEARCH", projectPath: other });
    await expect(f.registry.invoke("tau.workspace", "promote-scratch", f.input)).rejects.toThrow('A project named "Research" already exists.');
    await rm(f.path, { recursive: true });
    await expect(f.registry.invoke("tau.workspace", "promote-scratch", f.input)).rejects.toThrow("folder no longer exists");
    expect(f.refreshProject).not.toHaveBeenCalled();
  });

  it("rejects an active folder's Git option without stopping its runtime", async () => {
    const f = await fixture(); f.run();
    await expect(f.registry.invoke("tau.workspace", "promote-scratch", { ...f.input, git: true })).rejects.toThrow("Stop the threads");
    expect(f.abort).not.toHaveBeenCalled();
    expect(isScratchWorkspace(f.state, f.path)).toBe(true);
    await expect(stat(join(f.path, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back registration failure while keeping original files and configuration", async () => {
    const f = await fixture();
    const config = '{"other":"keep","iconPath":"custom.svg"}';
    await writeFile(join(f.path, "t3.json"), config);
    f.refreshProject.mockRejectedValueOnce(new Error("disk full"));
    await expect(f.registry.invoke("tau.workspace", "promote-scratch", f.input)).rejects.toThrow("disk full");
    expect(isScratchWorkspace(f.state, f.path)).toBe(true);
    expect(readPromotedProject(f.state, f.path)).toBeUndefined();
    expect(await readFile(join(f.path, "t3.json"), "utf8")).toBe(config);
    expect(await readFile(f.sessionFile, "utf8")).toBe(f.messages);
    expect(f.refreshProject).toHaveBeenCalledTimes(2);
  });

  it("rolls back Git and generated branding if registration fails, then allows retry", async () => {
    const f = await fixture();
    executable = join(f.state, "fixture-git");
    await writeFile(executable, '#!/bin/sh\nexec git -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false "$@"\n');
    await chmod(executable, 0o700);
    f.refreshProject.mockRejectedValueOnce(new Error("registration failed"));
    await expect(f.registry.invoke("tau.workspace", "promote-scratch", { ...f.input, git: true })).rejects.toThrow("registration failed");
    for (const file of [".git", "project-icon.svg", "t3.json"]) await expect(stat(join(f.path, file))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(f.path, "notes.txt"), "utf8")).toBe("untouched work\n");
    await f.registry.invoke("tau.workspace", "promote-scratch", { ...f.input, git: true });
    expect(execFileSync(executable, ["show", "HEAD:notes.txt"], { cwd: f.path, encoding: "utf8" })).toBe("untouched work\n");
    expect(execFileSync(executable, ["rev-list", "--count", "HEAD"], { cwd: f.path, encoding: "utf8" }).trim()).toBe("1");
  });

  it("does not replace existing Git metadata or branding", async () => {
    const f = await fixture();
    const external = join(f.state, "external-git"); await mkdir(external); await writeFile(join(external, "keep"), "existing metadata");
    await symlink(external, join(f.path, ".git"));
    await writeFile(join(f.path, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    await expect(f.registry.invoke("tau.workspace", "promote-scratch", { ...f.input, git: true })).rejects.toThrow("already belongs");
    expect(await readFile(join(external, "keep"), "utf8")).toBe("existing metadata");
    await f.registry.invoke("tau.workspace", "promote-scratch", f.input);
    await expect(stat(join(f.path, "t3.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an existing worktree and its branch at the exact same path", async () => {
    const f = await fixture();
    const main = join(f.state, "repository"); await mkdir(main);
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
    git(main, "init", "--quiet", "--initial-branch=main");
    git(main, "commit", "--allow-empty", "-qm", "Base");
    await rm(join(f.path, "notes.txt"));
    git(main, "worktree", "add", "-b", "existing-work", f.path);
    await writeFile(join(f.path, "notes.txt"), "existing worktree work");
    const pointer = await readFile(join(f.path, ".git"), "utf8");
    await f.registry.invoke("tau.workspace", "promote-scratch", f.input);
    expect(await readFile(join(f.path, ".git"), "utf8")).toBe(pointer);
    expect(git(f.path, "branch", "--show-current").trim()).toBe("existing-work");
    expect(git(main, "worktree", "list", "--porcelain", "-z")).toContain(`worktree ${f.path}\0`);
    expect(await readFile(join(f.path, "notes.txt"), "utf8")).toBe("existing worktree work");
  });

  it.each(["", "x".repeat(61), "bad\u0000name"])("refuses invalid display name %j", (name) => {
    expect(() => promotionName(name)).toThrow("1 to 60");
  });
});
