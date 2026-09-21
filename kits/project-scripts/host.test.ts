import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionServices, HostThreadLifecycle } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { createProjectScriptsHostExtension, type ProjectScriptsHostOptions } from "./host.js";
import {
  PROJECT_SCRIPTS_HOST_EXTENSION_ID,
  RUN_DISMISSED_EVENT,
  RUN_EVENT,
  SCRIPTS_CHANGED_EVENT,
  WORKTREE_CREATED_COMMAND,
  createProjectScriptsHostClient,
  type UiScriptRun,
} from "./protocol.js";
import type { ScriptProcess, ScriptSpawnOptions } from "./runner.js";
import type { WatchFn } from "./watch.js";

const made: string[] = [];
afterEach(async () => { await Promise.all(made.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function checkout(file?: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tau-project-scripts-host-"));
  made.push(directory);
  if (file !== undefined) await writeProjectFile(directory, file);
  return directory;
}

async function writeProjectFile(directory: string, file: unknown): Promise<void> {
  await mkdir(join(directory, ".tau"), { recursive: true });
  await writeFile(join(directory, ".tau", "project.json"), JSON.stringify(file));
}

interface FakeRun {
  options: ScriptSpawnOptions;
  kill: ReturnType<typeof vi.fn>;
  output(text: string): void;
  exit(code: number | null, signal?: string | null): void;
}

/** Scripts that end only when the test says so; `exit:<n>` ends by itself. */
function fakeSpawner() {
  const runs: FakeRun[] = [];
  const spawn = vi.fn((options: ScriptSpawnOptions): ScriptProcess => {
    let onOutput: (text: string) => void = () => undefined;
    let onExit: (code: number | null, signal: string | null) => void = () => undefined;
    const run: FakeRun = {
      options,
      kill: vi.fn(() => queueMicrotask(() => onExit(null, "SIGTERM"))),
      output: (text) => onOutput(text),
      exit: (code, signal = null) => onExit(code, signal),
    };
    runs.push(run);
    const selfExit = /^exit:(\d+)$/u.exec(options.command);
    if (selfExit) queueMicrotask(() => run.exit(Number(selfExit[1])));
    return {
      onOutput: (listener) => { onOutput = listener; },
      onExit: (listener) => { onExit = listener; },
      kill: () => run.kill(),
    };
  });
  return { spawn, runs };
}

async function activate(options: ProjectScriptsHostOptions, overrides: Partial<HostExtensionServices> = {}) {
  const events: PublishedKitEvent[] = [];
  const waiters: Array<{ match: (event: PublishedKitEvent) => boolean; resolve: (event: PublishedKitEvent) => void }> = [];
  let lifecycle: HostThreadLifecycle | undefined;
  const services: Partial<HostExtensionServices> = {
    cwd: () => "/project",
    knownWorkspacePath: async (path) => path,
    noteSubprocess: vi.fn(),
    thread: () => undefined,
    registerThreadLifecycle: (hooks) => { lifecycle = hooks; return () => { lifecycle = undefined; }; },
    ...overrides,
  };
  const registry = await activateHostKit(createProjectScriptsHostExtension({ watch: false, ...options }), services, (event) => {
    events.push(event);
    for (const waiter of [...waiters]) {
      if (!waiter.match(event)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(event);
    }
  });
  const invoke = (command: string, input?: unknown) => registry.invoke(PROJECT_SCRIPTS_HOST_EXTENSION_ID, command, input);
  const next = (match: (event: PublishedKitEvent) => boolean) => new Promise<PublishedKitEvent>((resolve) => {
    const seen = events.find(match);
    if (seen) resolve(seen);
    else waiters.push({ match, resolve });
  });
  const ended = async (runId: string) => (await next((event) => event.name === RUN_EVENT && (event.payload as UiScriptRun).id === runId && (event.payload as UiScriptRun).status !== "running")).payload as UiScriptRun;
  return { registry, events, invoke, client: createProjectScriptsHostClient(invoke), next, ended, lifecycle: () => lifecycle };
}

describe("Project Scripts host", () => {
  it("reads the scripts of the thread's own checkout, else the workspace's", async () => {
    const worktree = await checkout({ scripts: [{ name: "Build", command: "make" }] });
    const project = await checkout({ scripts: [{ name: "Serve", command: "npm start" }] });
    const kit = await activate({}, {
      thread: (sessionId) => sessionId === "thread-one" ? { sessionId, cwd: worktree } as never : undefined,
      knownWorkspacePath: async (id) => { if (id === "workspace-one") return project; throw new Error(`Unknown workspace ${id}`); },
    });
    expect((await kit.client.list({ sessionId: "thread-one", workspaceId: "workspace-one" })).scripts.map((script) => script.id)).toEqual(["build"]);
    expect((await kit.client.list({ sessionId: "gone", workspaceId: "workspace-one" })).scripts.map((script) => script.id)).toEqual(["serve"]);
    await expect(kit.client.list({ workspaceId: "elsewhere" })).rejects.toThrow("Unknown workspace elsewhere");
  });

  it("runs a script in its checkout and hands back the exit code and both output streams", async () => {
    const directory = await checkout({ scripts: [{ name: "Check", command: "echo out; echo err >&2; exit 3" }] });
    const kit = await activate({}, { cwd: () => directory });
    const { run, started } = await kit.client.run({ scriptId: "check" });
    expect(started).toBe(true);
    expect(run).toMatchObject({ scriptId: "check", status: "running", directory, trigger: "user" });
    const final = await kit.ended(run.id);
    expect(final).toMatchObject({ status: "failed", exitCode: 3 });
    expect(final.output).toContain("out\n");
    expect(final.output).toContain("err\n");
    expect(await kit.client.runs()).toEqual([expect.objectContaining({ id: run.id, status: "failed", exitCode: 3 })]);
  });

  it("does not start a running script twice, stops it on request and forgets it when dismissed", async () => {
    const directory = await checkout({ scripts: [{ name: "Serve", command: "npm start" }] });
    const { spawn, runs } = fakeSpawner();
    const kit = await activate({ spawn }, { cwd: () => directory });
    const first = await kit.client.run({ scriptId: "serve" });
    expect(runs[0].options).toMatchObject({ command: "npm start", cwd: directory, env: expect.objectContaining({ TAU_PROJECT_ROOT: directory, TAU_SCRIPT_ID: "serve" }) });
    const again = await kit.client.run({ scriptId: "serve" });
    expect(again).toEqual({ run: expect.objectContaining({ id: first.run.id }), started: false });
    expect(spawn).toHaveBeenCalledTimes(1);

    await expect(kit.client.dismiss({ runId: first.run.id })).rejects.toThrow("Stop the script before dismissing it.");
    await kit.client.stop({ runId: first.run.id });
    expect(runs[0].kill).toHaveBeenCalledTimes(1);
    expect(await kit.ended(first.run.id)).toMatchObject({ status: "stopped", signal: "SIGTERM" });

    await kit.client.dismiss({ runId: first.run.id });
    expect(kit.events).toContainEqual(expect.objectContaining({ name: RUN_DISMISSED_EVENT, payload: { id: first.run.id } }));
    expect(await kit.client.runs()).toEqual([]);
  });

  it("refuses a script the file does not have", async () => {
    const directory = await checkout({ scripts: [] });
    const kit = await activate({}, { cwd: () => directory });
    await expect(kit.client.run({ scriptId: "deploy" })).rejects.toThrow(`No script "deploy" in ${join(directory, ".tau", "project.json")}.`);
    await expect(kit.invoke("run", {})).rejects.toThrow('Project Scripts needs "scriptId".');
  });

  it("says when a script's preview answers", async () => {
    const directory = await checkout({ scripts: [{ name: "Serve", command: "python3 -m http.server 8000", previewUrl: "http://localhost:8000" }] });
    const { spawn } = fakeSpawner();
    const probe = vi.fn(async () => true);
    const kit = await activate({ spawn, probe }, { cwd: () => directory });
    const { run } = await kit.client.run({ scriptId: "serve" });
    expect(run).toMatchObject({ previewUrl: "http://localhost:8000/", autoOpenPreview: true });
    const ready = await kit.next((event) => event.name === RUN_EVENT && (event.payload as UiScriptRun).previewReady === true);
    expect(ready.payload).toMatchObject({ id: run.id, status: "running" });
    expect(probe).toHaveBeenCalledWith("http://localhost:8000/");
  });

  it("runs the worktree setup in the new worktree: blocking scripts before it answers, the others in the background", async () => {
    const project = await checkout({
      runOnWorktreeCreate: "exit:0",
      scripts: [
        { name: "Watch", command: "npm run watch", runOnWorktreeCreate: true },
        { name: "Install", command: "exit:1", runOnWorktreeCreate: true, async: false },
        { name: "Serve", command: "npm start" },
      ],
    });
    const worktree = await checkout();
    const { spawn, runs } = fakeSpawner();
    const log = vi.fn();
    const kit = await activate({ spawn }, { log });
    const answer = await kit.invoke(WORKTREE_CREATED_COMMAND, { project, worktree }) as { runs: UiScriptRun[] };
    expect(answer.runs.map((run) => [run.scriptId, run.status, run.trigger])).toEqual([
      ["setup", "succeeded", "worktree-create"],
      ["watch", "running", "worktree-create"],
      ["install", "failed", "worktree-create"],
    ]);
    expect(runs.map((run) => run.options.cwd)).toEqual([worktree, worktree, worktree]);
    expect(runs[0].options.env).toMatchObject({ TAU_PROJECT_ROOT: project, TAU_WORKTREE_PATH: worktree });
    expect(log).toHaveBeenCalledWith("git.worktree.setup-failed", "install exited with 1");
    await expect(kit.invoke(WORKTREE_CREATED_COMMAND, { project: "relative", worktree })).rejects.toThrow("absolute");
  });

  it("stops the scripts of a workspace the host left, and every script when it deactivates", async () => {
    const directory = await checkout({ scripts: [{ name: "Serve", command: "npm start" }, { name: "Watch", command: "npm run watch" }] });
    const { spawn, runs } = fakeSpawner();
    const kit = await activate({ spawn }, { cwd: () => directory });
    await kit.client.run({ scriptId: "serve" });
    await kit.lifecycle()?.afterWorkspaceClose?.(directory, "switch");
    expect(runs[0].kill).toHaveBeenCalledTimes(1);
    await kit.client.run({ scriptId: "watch" });
    await kit.registry.deactivate(PROJECT_SCRIPTS_HOST_EXTENSION_ID);
    expect(runs[1].kill).toHaveBeenCalledTimes(1);
  });

  it("pushes a change when a followed project file changes on disk", async () => {
    const directory = await checkout({ scripts: [{ name: "Build", command: "make" }] });
    const listeners = new Map<string, (event: string, filename: string | null) => void>();
    const watch: WatchFn = (path, listener) => {
      listeners.set(path, listener);
      return { close: () => listeners.delete(path), on: () => undefined };
    };
    const kit = await activate({ watch, debounceMs: 0 }, { cwd: () => directory });
    await kit.client.list({});
    expect([...listeners.keys()].sort()).toEqual([directory, join(directory, ".tau")]);

    await writeProjectFile(directory, { scripts: [{ name: "Build", command: "make all" }] });
    listeners.get(join(directory, ".tau"))?.("change", "project.json");
    expect((await kit.next((event) => event.name === SCRIPTS_CHANGED_EVENT)).payload).toEqual({ directory });

    await kit.registry.deactivate(PROJECT_SCRIPTS_HOST_EXTENSION_ID);
    expect(listeners.size).toBe(0);
  });
});
