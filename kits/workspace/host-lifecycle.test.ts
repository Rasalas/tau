import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  type HostExtensionServices,
  type HostSessionFile,
  type HostThread,
} from "tau/host-extension";
import { TURN_CHECKPOINT_CUSTOM_TYPE } from "./turn-checkpoint-codec.js";
import type { UiTurnCheckpoint } from "./turn-checkpoint-types.js";
import type { WorkspaceKitCheckpointMaintenance } from "./workspace-kit-checkpoints.js";
import { createWorkspaceKitLifecycle, prioritizeRestoreTargetSession } from "./host-lifecycle.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "tau-kit-lifecycle-"));
  directories.push(path);
  return path;
}

const checkpoint: UiTurnCheckpoint = {
  id: "turn-1",
  turnId: "turn-1",
  sessionId: "session",
  anchorMessageId: "assistant-entry",
  beforeSnapshotId: "refs/tau/checkpoints/session/turn-1/before",
  afterSnapshotId: "refs/tau/checkpoints/session/turn-1/after",
  startedAt: 10,
  endedAt: 20,
  files: [{ path: "src/app.ts", name: "app.ts", directory: "src", status: "modified", added: 1, removed: 0 }],
  added: 1,
  removed: 0,
  branch: "main",
};
const branch = [
  { type: "message", id: "assistant-entry", message: { role: "assistant", content: [] } },
  { type: "custom", id: "custom-1", customType: TURN_CHECKPOINT_CUSTOM_TYPE, data: checkpoint },
];

function thread(overrides: Partial<HostThread> = {}): HostThread {
  return {
    sessionId: "session",
    cwd: "/project",
    backendKind: "pi",
    sessionFile: "/sessions/session.jsonl",
    isStreaming: () => false,
    isIdle: () => true,
    waitForIdle: async () => undefined,
    isCurrent: () => true,
    sessionName: () => undefined,
    transcript: async () => [],
    completeTitle: async () => "",
    complete: async () => "",
    modelApi: () => undefined,
    shortcuts: () => [],
    runShortcut: async () => false,
    entries: () => branch,
    appendEntry: () => undefined,
    ...overrides,
  };
}

function sessionFile(overrides: Partial<HostSessionFile> = {}): HostSessionFile {
  return {
    path: "/sessions/session.jsonl",
    sessionId: "session",
    cwd: "/project",
    entries: () => branch,
    leafId: () => "assistant-entry",
    appendEntry: () => undefined,
    appendInfo: () => undefined,
    branch: () => undefined,
    ...overrides,
  };
}

function services(overrides: Partial<HostExtensionServices> = {}): HostExtensionServices {
  return {
    cwd: () => "/project",
    agentDir: "/agent",
    sessionsDir: "/agent/sessions",
    stateDir: "/state",
    safeMode: false,
    log: () => undefined,
    openWorkspace: async () => ({ version: 1 as const, updates: [] }),
    knownWorkspacePath: async (path) => path,
    workspaceRef: (path: string) => ({ workspaceId: `ws1_${path}`, displayPath: path }),
    projectName: async () => "project",
    rememberProjectName: () => undefined,
    pickDirectory: async () => undefined,
    runtimeOwner: () => "tau",
    thread: () => undefined,
    attachedRuntime: () => undefined,
    describeProjects: () => () => undefined,
    noteSubprocess: () => undefined,
    findCommand: () => undefined,
    skills: () => [],
    refreshExtensionPackages: async () => undefined,
    listPackages: async () => [],
    installPackage: async () => { throw new Error("no installer in this test"); },
    removePackage: async () => { throw new Error("no installer in this test"); },
    updatePackages: async () => [],
    sessions: {
      list: async () => [],
      open: () => { throw new Error("no such session"); },
      prepare: async () => { throw new Error("no runtimes here"); },
      start: async () => { throw new Error("no threads in this test"); },
      exclusive: (work) => work(),
      refreshIndex: async () => ({ version: 1 as const, type: "thread-index" as const, index: { projects: [], sessions: [] } }),
    },
    setThreadTitle: async () => undefined,
    registerThreadLifecycle: () => () => undefined,
    registerTurnObserver: () => () => undefined,
    pinTranscriptEntries: () => () => undefined,
    registerRuntimeExtension: () => () => undefined,
    loadRuntimeExtension: async () => { throw new Error("no runtime packages in this test"); },
    decorateUiPrompt: () => () => undefined,
    setPermissionLevel: () => undefined,
    registerRuntimeBackend: () => () => undefined,
    presentUi: () => () => undefined,
    ...overrides,
  };
}

function maintenance(): WorkspaceKitCheckpointMaintenance & { calls: Record<string, ReturnType<typeof vi.fn>> } {
  const calls = {
    cleanupSessionRefs: vi.fn(async () => undefined),
    cleanupOrphanRefs: vi.fn(async () => undefined),
    cleanupLiveRefs: vi.fn(async () => undefined),
    rehomeFork: vi.fn(async () => undefined),
  };
  return { ...calls, calls };
}

describe("Workspace Kit checkpoint lifecycle", () => {
  it("lists a thread's checkpoints from its branch and pins their anchors", async () => {
    const kit = createWorkspaceKitLifecycle(services({ thread: () => thread() }), { emit: () => undefined });
    await expect(kit.checkpoints("session")).resolves.toEqual({ checkpoints: [expect.objectContaining({ id: "turn-1" })], restoreSupported: true });
    expect(kit.pinnedEntries(thread())).toEqual(["assistant-entry"]);
    expect(kit.pinnedEntries(thread({ entries: () => [] }))).toEqual([]);
  });

  it("lists persisted checkpoints after a thread runtime was released", async () => {
    const open = vi.fn(() => sessionFile());
    const kit = createWorkspaceKitLifecycle(services({
      sessions: {
        list: async () => [{ sessionId: "session", path: "/sessions/session.jsonl", cwd: "/project" }],
        open,
        prepare: async () => { throw new Error("no runtimes here"); },
        start: async () => { throw new Error("no threads in this test"); },
        exclusive: (work) => work(),
        refreshIndex: async () => ({ version: 1 as const, type: "thread-index" as const, index: { projects: [], sessions: [] } }),
      },
    }), { emit: () => undefined });

    await expect(kit.checkpoints("session")).resolves.toEqual({
      checkpoints: [expect.objectContaining({ id: "turn-1" })],
      restoreSupported: false,
    });
    expect(open).toHaveBeenCalledWith("/sessions/session.jsonl");
  });

  it("asks the Pi terminal that owns a thread and never offers restore there", async () => {
    const invoke = vi.fn(async () => ({ checkpoints: [checkpoint], restoreSupported: true }));
    const kit = createWorkspaceKitLifecycle(services({ attachedRuntime: () => ({ sessionId: "session", invoke }) }), { emit: () => undefined });
    await expect(kit.checkpoints("session")).resolves.toEqual({ checkpoints: [checkpoint], restoreSupported: false });
    expect(invoke).toHaveBeenCalledWith("tau.workspace", "checkpoints", { sessionId: "session" });
    await expect(kit.canRestore("session", "turn-1")).resolves.toBe(false);
    await expect(kit.restore("session", "turn-1")).rejects.toThrow("Pi owns this thread");
  });

  it("repairs the workspace before any thread is activated, even a non-Pi one", async () => {
    // A cross-project switch may open a normal (non-Pi) thread in project B.
    // Its workspace still needs pending clean/read-tree recovery before the
    // thread is exposed, even though it has no backup marker of its own.
    const list = vi.fn(async () => []);
    const kit = createWorkspaceKitLifecycle(services({ sessions: { list, open: () => { throw new Error("none"); }, prepare: async () => { throw new Error("none"); }, start: async () => { throw new Error("none"); }, exclusive: (work) => work(), refreshIndex: async () => ({ version: 1 as const, type: "thread-index" as const, index: { projects: [], sessions: [] } }) } }), { emit: () => undefined });
    await expect(kit.lifecycle.beforeActivate!(thread({ cwd: "/project-b", backendKind: "claude-code" }))).resolves.toBeUndefined();
    expect(list).toHaveBeenCalledOnce();
  });

  it("cleans orphan refs before a session's runtime opens", async () => {
    const upkeep = maintenance();
    const kit = createWorkspaceKitLifecycle(services(), { emit: () => undefined, maintenance: upkeep });
    await kit.lifecycle.beforeOpen!(sessionFile());
    expect(upkeep.calls.cleanupOrphanRefs).toHaveBeenCalledWith("/project", "session", [expect.objectContaining({ id: "turn-1" })], []);
  });

  it("carries the source's checkpoints into a fork whose branch holds their anchors", async () => {
    const upkeep = maintenance();
    const open = vi.fn(() => sessionFile());
    const kit = createWorkspaceKitLifecycle(services({ sessions: { list: async () => [], open, prepare: async () => { throw new Error("none"); }, start: async () => { throw new Error("none"); }, exclusive: (work) => work(), refreshIndex: async () => ({ version: 1 as const, type: "thread-index" as const, index: { projects: [], sessions: [] } }) } }), { emit: () => undefined, maintenance: upkeep, hasSnapshotRefs: async () => true });
    const target = sessionFile({ path: "/sessions/fork.jsonl", sessionId: "fork", entries: () => [branch[0]!] });
    await kit.lifecycle.afterFork!(thread(), target);
    expect(open).toHaveBeenCalledWith("/sessions/session.jsonl");
    expect(upkeep.calls.rehomeFork).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/project",
      sourceSessionId: "session",
      targetSessionId: "fork",
      checkpoints: [expect.objectContaining({ id: "turn-1" })],
    }));
    upkeep.calls.rehomeFork.mockClear();
    await kit.lifecycle.afterFork!(thread(), sessionFile({ sessionId: "empty", entries: () => [] }));
    expect(upkeep.calls.rehomeFork).not.toHaveBeenCalled();
  });

  it("forks without a checkpoint whose snapshot refs were pruned", async () => {
    const upkeep = maintenance();
    const logs: string[] = [];
    const open = vi.fn(() => sessionFile());
    const kit = createWorkspaceKitLifecycle(
      services({ log: (label, detail) => { logs.push(`${label} ${detail ?? ""}`); }, sessions: { list: async () => [], open, prepare: async () => { throw new Error("none"); }, start: async () => { throw new Error("none"); }, exclusive: (work) => work(), refreshIndex: async () => ({ version: 1 as const, type: "thread-index" as const, index: { projects: [], sessions: [] } }) } }),
      { emit: () => undefined, maintenance: upkeep, hasSnapshotRefs: async () => false },
    );
    await kit.lifecycle.afterFork!(thread(), sessionFile({ path: "/sessions/fork.jsonl", sessionId: "fork", entries: () => [branch[0]!] }));
    expect(upkeep.calls.rehomeFork).not.toHaveBeenCalled();
    expect(logs).toEqual([expect.stringContaining("fork.checkpoint.skipped turn-1")]);
  });

  it("sweeps every workspace it knows and drops the refs of deleted sessions", async () => {
    const upkeep = maintenance();
    const a = await workspace();
    const b = await workspace();
    const kit = createWorkspaceKitLifecycle(services({
      sessions: { list: async () => [], open: () => sessionFile({ cwd: a }), prepare: async () => { throw new Error("none"); }, start: async () => { throw new Error("none"); }, exclusive: (work) => work(), refreshIndex: async () => ({ version: 1 as const, type: "thread-index" as const, index: { projects: [], sessions: [] } }) },
    }), { emit: () => undefined, maintenance: upkeep });
    await kit.lifecycle.sweep!({
      sessions: [{ sessionId: "session", path: "/sessions/session.jsonl", cwd: a }],
      liveThreads: [thread({ sessionId: "live", cwd: b, entries: () => [] })],
      projectPaths: [b],
      deleted: [{ sessionId: "gone", cwd: a }],
    });
    const swept = upkeep.calls.cleanupLiveRefs.mock.calls.map((call) => call[0]).sort();
    expect(swept).toEqual([a, b].sort());
    const live = upkeep.calls.cleanupLiveRefs.mock.calls[0]![1] as Array<{ sessionId: string }>;
    expect(live.map((session) => session.sessionId).sort()).toEqual(["live", "session"]);
    expect(upkeep.calls.cleanupSessionRefs).toHaveBeenCalledWith(a, "gone");
  });

  it("reports historical diffs as unavailable for a thread without a capture runtime", async () => {
    const cwd = await workspace();
    const kit = createWorkspaceKitLifecycle(services({ thread: () => thread({ cwd }) }), { emit: () => undefined });
    await expect(kit.turnFileDiff("session", "turn-1", "src/app.ts")).resolves.toMatchObject({ note: "Turn checkpoint history is unavailable." });
    await expect(kit.turnFileDiff("session", "missing", "src/app.ts")).resolves.toMatchObject({ note: "This turn checkpoint is no longer available." });
    await expect(kit.turnFiles("session", "turn-1")).rejects.toThrow("unavailable");
  });
});

describe("restore target discovery", () => {
  it("keeps the restored target newer than its backup for restart discovery", async () => {
    const directory = await mkdtemp(`${tmpdir()}/tau-restore-mtime-`);
    directories.push(directory);
    const targetPath = `${directory}/target.jsonl`;
    const backupPath = `${directory}/backup.jsonl`;
    const header = (id: string) => `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: "/project" })}\n`;
    await writeFile(targetPath, header("target"));
    await writeFile(backupPath, header("backup"));
    await utimes(targetPath, new Date(1_000), new Date(1_000));
    await utimes(backupPath, new Date(2_000), new Date(2_000));

    await prioritizeRestoreTargetSession(targetPath, backupPath);

    // continueRecent delegates to the SDK's findMostRecentSession helper.
    expect(SessionManager.continueRecent("/project", directory).getSessionFile()).toBe(targetPath);
    expect((await stat(targetPath)).mtimeMs).toBeGreaterThan((await stat(backupPath)).mtimeMs);
  });
});
