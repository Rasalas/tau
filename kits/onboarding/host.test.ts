import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostExtension } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import createOnboardingHostExtension, { runProbe, toolCommands } from "./host.js";
import type { Discovery, ImportResult, ToolsReport, WelcomeState } from "./protocol.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

/** A backend kit answering the two import commands, granted to Onboarding or not. */
function backendKit(id: string, sessions: unknown[], grant = true): HostExtension & { imported: string[][] } {
  const imported: string[][] = [];
  return {
    id,
    name: id,
    imported,
    activate(context) {
      const options = grant ? { callers: ["tau.onboarding"] } : {};
      context.registerCommand("import-scan", () => ({ sessions }), options);
      context.registerCommand("import-sessions", (input) => {
        const paths = (input as { paths: string[] }).paths;
        imported.push(paths);
        return { imported: paths.filter((path) => !path.includes("old")), skipped: paths.filter((path) => path.includes("old")).length, failed: [], update: { type: "thread-index" } };
      }, options);
    },
  };
}

async function harness(options: { piSessions?: Array<{ sessionId: string; path: string; cwd: string }>; grantCodex?: boolean; claudeSessions?: (root: string) => Promise<unknown[]> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tau-onboarding-"));
  directories.push(root);
  const alpha = join(root, "alpha");
  await mkdir(join(alpha, ".git"), { recursive: true });
  const events: PublishedKitEvent[] = [];
  const registry = await activateHostKit(createOnboardingHostExtension({
    platform: "darwin",
    home: root,
    run: async (_command, args) => ({ ok: args[0] !== "auth", stdout: "gh version 2.81.0 (2026-09-01)" }),
  }) as unknown as HostExtension, {
    stateDir: join(root, "state"),
    findCommand: (name: string) => name === "gh" ? "/opt/homebrew/bin/gh" : undefined,
    noteSubprocess: () => undefined,
    workspaceRef: (path: string) => ({ workspaceId: `ws:${path}`, displayPath: path }),
    admitWorkspace: (path: string) => ({ workspaceId: `ws:${path}`, displayPath: path }),
    sessions: { list: async () => options.piSessions ?? [] } as never,
  } as never, (event) => events.push(event));
  const claude = backendKit("tau.claude-code", options.claudeSessions ? await options.claudeSessions(root) : [
    { path: "/h/a.jsonl", sessionId: "a", cwd: alpha, title: "Fix it", updatedAt: 200, imported: false },
    { path: "/h/gone.jsonl", sessionId: "g", cwd: join(root, "gone"), title: "Gone", updatedAt: 300, imported: false },
    { broken: true },
  ]);
  const codex = backendKit("tau.codex", [{ path: "/h/b.jsonl", sessionId: "b", cwd: alpha, title: "Flag", updatedAt: 100, imported: true }], options.grantCodex ?? true);
  await registry.activate(claude);
  await registry.activate(codex);
  const invoke = <T>(command: string, input?: unknown) => registry.invoke("tau.onboarding", command, input) as Promise<T>;
  return { root, alpha, invoke, events, claude, codex };
}

describe("Onboarding host half", () => {
  it("opens by itself only until it is completed, and only without threads", async () => {
    const fresh = await harness();
    await expect(fresh.invoke<WelcomeState>("state")).resolves.toEqual({ completed: false, firstStart: true });
    await fresh.invoke("complete");
    await expect(fresh.invoke<WelcomeState>("state")).resolves.toEqual({ completed: true, firstStart: false });

    const used = await harness({ piSessions: [{ sessionId: "s", path: "/s.jsonl", cwd: "/work" }] });
    await expect(used.invoke<WelcomeState>("state")).resolves.toEqual({ completed: false, firstStart: false });
  });

  it("reports the CLIs it finds with their version and login, and the vendors' commands for the rest", async () => {
    const { invoke } = await harness();
    const report = await invoke<ToolsReport>("tools");
    expect(report.tools.find((tool) => tool.id === "gh")).toEqual({ id: "gh", path: "/opt/homebrew/bin/gh", version: "2.81.0", signedIn: false, install: "brew install gh", login: "gh auth login" });
    expect(report.tools.find((tool) => tool.id === "codex")).toEqual({ id: "codex", install: "curl -fsSL https://chatgpt.com/codex/install.sh | sh", login: "codex login" });
    expect(toolCommands("win32")["claude-code"].install).toBe("irm https://claude.ai/install.ps1 | iex");
  });

  it("answers for a CLI that is no program instead of throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-onboarding-probe-"));
    directories.push(root);
    const broken = join(root, "glab");
    await writeFile(broken, "echo no shebang\n", { mode: 0o755 });
    await expect(runProbe(broken, ["--version"])).resolves.toEqual({ ok: false, stdout: "" });
  });

  it("gathers the backends' sessions into folders that still exist, newest first", async () => {
    const { invoke, alpha } = await harness({ grantCodex: false });
    const discovery = await invoke<Discovery>("discover");
    expect(discovery.sessions.map((session) => `${session.source}:${session.sessionId}`)).toEqual(["claude-code:g", "claude-code:a"]);
    expect(discovery.projects).toEqual([{ path: alpha, name: "alpha", sources: ["claude-code"], threadCount: 1, lastActiveAt: 200, git: true }]);
    // A backend that did not grant the command is named, not fatal.
    expect(discovery.unavailable.map((entry) => entry.source)).toEqual(["codex", "opencode"]);
  });

  it("names each repository's origin, and offers no worktree, no Downloads and not home itself", async () => {
    const session = (cwd: string, updatedAt: number) => ({ path: `${cwd}/s.jsonl`, sessionId: cwd, cwd, title: "", updatedAt, imported: false });
    const { invoke, root } = await harness({
      claudeSessions: async (home) => {
        const clone = async (name: string, url: string) => {
          await mkdir(join(home, name, ".git", "worktrees", "wt"), { recursive: true });
          await writeFile(join(home, name, ".git", "config"), `[remote "origin"]\n\turl = ${url}\n`);
        };
        await clone("app", "git@github.com:acme/app.git");
        await clone("app-copy", "https://github.com/acme/app");
        await mkdir(join(home, "app-wt"));
        await writeFile(join(home, "app-wt", ".git"), `gitdir: ${join(home, "app", ".git", "worktrees", "wt")}\n`);
        await mkdir(join(home, "Downloads", "tool"), { recursive: true });
        return [session(join(home, "app"), 5), session(join(home, "app-copy"), 4), session(join(home, "app-wt"), 3), session(join(home, "Downloads", "tool"), 2), session(home, 1)];
      },
    });
    const discovery = await invoke<Discovery>("discover");
    // Codex's session keeps alpha (no origin) on top.
    expect(discovery.projects.map((project) => [project.name, project.remote?.key])).toEqual([
      ["alpha", undefined],
      ["app", "github.com/acme/app"],
      ["app-copy", "github.com/acme/app"],
    ]);
    expect(discovery.projects[1]!.remote).toEqual({ key: "github.com/acme/app", label: "acme/app" });
    expect(discovery.projects.some((project) => project.path === root)).toBe(false);
  });

  it("hands the import to the backend in batches and reports progress as it goes", async () => {
    const { invoke, events, claude } = await harness();
    const paths = Array.from({ length: 12 }, (_, index) => `/h/${index === 3 ? "old" : "new"}-${index}.jsonl`);
    const result = await invoke<ImportResult>("import-sessions", { source: "claude-code", paths });
    expect(result).toEqual({ imported: 11, skipped: 1, failed: 0, update: { type: "thread-index" } });
    expect(claude.imported.map((batch) => batch.length)).toEqual([10, 2]);
    expect(events.filter((event) => event.name === "import-progress").map((event) => event.payload)).toEqual([
      { source: "claude-code", done: 10, total: 12 },
      { source: "claude-code", done: 12, total: 12 },
    ]);
    await expect(invoke("import-sessions", { source: "pi", paths })).rejects.toThrow("needs a source");
  });

  it("admits a found folder as a workspace, and refuses one that is not there", async () => {
    const { invoke, alpha, root } = await harness();
    await expect(invoke("project-ref", { path: alpha })).resolves.toEqual({ workspaceId: `ws:${alpha}`, displayPath: alpha });
    await expect(invoke("project-ref", { path: join(root, "gone") })).rejects.toThrow("does not exist");
  });
});
