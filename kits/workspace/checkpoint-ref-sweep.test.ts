import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { HostExtensionServices, HostSessionFile, HostThread } from "tau/host-extension";
import { createWorkspaceKitLifecycle } from "./host-lifecycle.js";
import {
  TURN_CHECKPOINT_CUSTOM_TYPE,
  turnSnapshotRef,
} from "./turn-checkpoint-codec.js";
import type { StoredTurnCheckpoint } from "./turn-checkpoint-types.js";
import { createTurnWorkspaceSnapshot } from "./workspace-git.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function repository(prefix: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  directories.push(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "tau@example.test"], { cwd });
  execFileSync("git", ["config", "user.name", "Tau Test"], { cwd });
  await writeFile(join(cwd, "tracked.txt"), "base\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd });
  return cwd;
}

function listRefs(cwd: string): string[] {
  return execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/tau/"], { cwd, encoding: "utf8" })
    .split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Captures a real before/after pair for one turn, with a file edit in between. */
async function captureTurn(cwd: string, sessionId: string, turnId: string, content: string): Promise<StoredTurnCheckpoint> {
  await createTurnWorkspaceSnapshot(cwd, sessionId, turnId, "before");
  await writeFile(join(cwd, "tracked.txt"), content);
  await createTurnWorkspaceSnapshot(cwd, sessionId, turnId, "after");
  return {
    id: turnId,
    turnId,
    sessionId,
    anchorMessageId: `assistant-${turnId}`,
    beforeSnapshotId: turnSnapshotRef(sessionId, turnId, "before"),
    afterSnapshotId: turnSnapshotRef(sessionId, turnId, "after"),
    startedAt: Date.now() - 1_000,
    endedAt: Date.now(),
    files: [{ path: "tracked.txt", name: "tracked.txt", directory: "", status: "modified", added: 1, removed: 1 }],
    fileCount: 1,
    added: 1,
    removed: 1,
  };
}

interface SessionFixture {
  sessionId: string;
  path: string;
  cwd: string;
  /** Entries the live runtime holds; the file on disk may hold fewer. */
  liveEntries: unknown[];
}

/**
 * A persisted session whose file deliberately lags its live thread: the
 * assistant entry is durable, the checkpoint entry is not yet.
 */
async function laggingSession(cwd: string, sessionsDir: string, sessionId: string, checkpoint: StoredTurnCheckpoint): Promise<SessionFixture> {
  const path = join(sessionsDir, `${sessionId}.jsonl`);
  const assistant = {
    type: "message",
    id: checkpoint.anchorMessageId,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "assistant", content: [{ type: "text", text: "done" }] },
  };
  await writeFile(path, [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd }),
    JSON.stringify(assistant),
    "",
  ].join("\n"));
  return {
    sessionId,
    path,
    cwd,
    liveEntries: [assistant, {
      type: "custom",
      id: `custom-${checkpoint.turnId}`,
      parentId: assistant.id,
      timestamp: new Date().toISOString(),
      customType: TURN_CHECKPOINT_CUSTOM_TYPE,
      data: checkpoint,
    }],
  };
}

function liveThread(fixture: SessionFixture): HostThread {
  return {
    sessionId: fixture.sessionId,
    cwd: fixture.cwd,
    backendKind: "pi",
    sessionFile: fixture.path,
    isStreaming: () => false,
    isIdle: () => true,
    waitForIdle: async () => undefined,
    isCurrent: () => true,
    sessionName: () => undefined,
    transcript: async () => [],
    complete: async () => "",
    modelApi: () => undefined,
    shortcuts: () => [],
    runShortcut: async () => false,
    entries: () => fixture.liveEntries,
    appendEntry: () => undefined,
  };
}

function services(cwd: string, sessionsDir: string, threads: readonly HostThread[] = []): HostExtensionServices {
  return {
    cwd: () => cwd,
    complete: async () => "",
    agentDir: sessionsDir,
    sessionsDir,
    stateDir: sessionsDir,
    safeMode: false,
    log: () => undefined,
    openWorkspace: async () => ({ version: 1 as const, updates: [] }),
    knownWorkspacePath: async (path) => path,
    workspaceRef: (path: string) => ({ workspaceId: `ws1_${path}`, displayPath: path }),
    projectName: async () => "project",
    rememberProjectName: () => undefined,
    pickDirectory: async () => undefined,
    runtimeOwner: () => "tau",
    thread: (sessionId?: string) => sessionId === undefined
      ? threads[0]
      : threads.find((item) => item.sessionId === sessionId),
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
      open: (path) => {
        const manager = SessionManager.open(path);
        const file: HostSessionFile = {
          path,
          sessionId: manager.getSessionId(),
          cwd: manager.getCwd(),
          entries: () => manager.getBranch(),
          leafId: () => manager.getLeafId() ?? undefined,
          appendEntry: (customType, data) => { manager.appendCustomEntry(customType, data); },
          appendInfo: (text) => { manager.appendSessionInfo(text); },
          branch: () => undefined,
        };
        return file;
      },
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
    loadDependency: async () => { throw new Error("no dependencies in this test"); },
    decorateUiPrompt: () => () => undefined,
    setPermissionLevel: () => undefined,
    registerRuntimeBackend: () => () => undefined,
    presentUi: () => () => undefined,
    callClient: async () => { throw new Error("no window half in this test"); },
  };
}

describe("checkpoint refs of a live thread whose session file lags", () => {
  it("keeps the refs of a checkpoint the live thread holds but the file has not caught up with", async () => {
    const cwd = await repository("tau-ref-sweep-lag-");
    const sessionsDir = await mkdtemp(join(tmpdir(), "tau-ref-sweep-sessions-"));
    directories.push(sessionsDir);
    const checkpoint = await captureTurn(cwd, "live-session", "turn-1", "after\n");
    const fixture = await laggingSession(cwd, sessionsDir, "live-session", checkpoint);
    expect(listRefs(cwd)).toHaveLength(2);

    const thread = liveThread(fixture);
    const kit = createWorkspaceKitLifecycle(services(cwd, sessionsDir, [thread]), { emit: () => undefined });
    await kit.lifecycle.sweep!({
      sessions: [{ sessionId: fixture.sessionId, path: fixture.path, cwd: fixture.cwd }],
      liveThreads: [thread],
      projectPaths: [cwd],
      deleted: [],
    });

    expect(listRefs(cwd)).toEqual([
      turnSnapshotRef("live-session", "turn-1", "after"),
      turnSnapshotRef("live-session", "turn-1", "before"),
    ]);
  }, 30_000);

  it("keeps a sub-agent's refs when the parent thread of the same workspace is swept", async () => {
    const cwd = await repository("tau-ref-sweep-child-");
    const sessionsDir = await mkdtemp(join(tmpdir(), "tau-ref-sweep-child-sessions-"));
    directories.push(sessionsDir);
    const parent = await captureTurn(cwd, "parent-session", "turn-p", "parent\n");
    const child = await captureTurn(cwd, "child-session", "turn-c", "child\n");
    const parentFixture = await laggingSession(cwd, sessionsDir, "parent-session", parent);
    const childFixture = await laggingSession(cwd, sessionsDir, "child-session", child);
    expect(listRefs(cwd)).toHaveLength(4);

    const threads = [liveThread(parentFixture), liveThread(childFixture)];
    const kit = createWorkspaceKitLifecycle(services(cwd, sessionsDir, threads), { emit: () => undefined });
    await kit.lifecycle.sweep!({
      sessions: [parentFixture, childFixture].map((fixture) => ({ sessionId: fixture.sessionId, path: fixture.path, cwd: fixture.cwd })),
      liveThreads: threads,
      projectPaths: [cwd],
      deleted: [],
    });

    expect(listRefs(cwd)).toHaveLength(4);
  }, 30_000);

  it("keeps the refs of a live thread while another thread of the same workspace opens", async () => {
    const cwd = await repository("tau-ref-sweep-open-");
    const sessionsDir = await mkdtemp(join(tmpdir(), "tau-ref-sweep-open-sessions-"));
    directories.push(sessionsDir);
    const checkpoint = await captureTurn(cwd, "opening-session", "turn-1", "after\n");
    const fixture = await laggingSession(cwd, sessionsDir, "opening-session", checkpoint);

    const thread = liveThread(fixture);
    const kit = createWorkspaceKitLifecycle(services(cwd, sessionsDir, [thread]), { emit: () => undefined });
    // Reopening the same session reads the file, which does not yet hold the entry.
    await kit.lifecycle.beforeOpen!({
      path: fixture.path,
      sessionId: fixture.sessionId,
      cwd,
      entries: () => SessionManager.open(fixture.path).getBranch(),
      leafId: () => undefined,
      appendEntry: () => undefined,
      appendInfo: () => undefined,
      branch: () => undefined,
    });

    expect(listRefs(cwd)).toHaveLength(2);
  }, 30_000);

  it("keeps the refs of a lagging session no live thread of this host claims", async () => {
    // A Pi terminal Tau is only attached to, or a second Tau, writes the entry
    // in its own process. This host sees neither a live thread nor the entry.
    const cwd = await repository("tau-ref-sweep-attached-");
    const sessionsDir = await mkdtemp(join(tmpdir(), "tau-ref-sweep-attached-sessions-"));
    directories.push(sessionsDir);
    const checkpoint = await captureTurn(cwd, "attached-session", "turn-1", "after\n");
    const fixture = await laggingSession(cwd, sessionsDir, "attached-session", checkpoint);

    const kit = createWorkspaceKitLifecycle(services(cwd, sessionsDir), { emit: () => undefined });
    await kit.lifecycle.sweep!({
      sessions: [{ sessionId: fixture.sessionId, path: fixture.path, cwd: fixture.cwd }],
      liveThreads: [],
      projectPaths: [cwd],
      deleted: [],
    });

    expect(listRefs(cwd)).toHaveLength(2);
  }, 30_000);

  it("still reclaims the refs of a session that is neither persisted nor live", async () => {
    const cwd = await repository("tau-ref-sweep-gone-");
    const sessionsDir = await mkdtemp(join(tmpdir(), "tau-ref-sweep-gone-sessions-"));
    directories.push(sessionsDir);
    await captureTurn(cwd, "gone-session", "turn-1", "after\n");
    expect(listRefs(cwd)).toHaveLength(2);

    const kit = createWorkspaceKitLifecycle(services(cwd, sessionsDir), { emit: () => undefined });
    await kit.lifecycle.sweep!({ sessions: [], liveThreads: [], projectPaths: [cwd], deleted: [] });

    expect(listRefs(cwd)).toEqual([]);
  }, 30_000);
});
