import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultShell } from "./shell.js";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import type { HostExtensionServices, HostThreadLifecycle } from "tau/host-extension";
import { createTerminalHostExtension, loadNodePty, MAX_SESSIONS_PER_WORKSPACE, NO_PTY, TerminalSessions, type PtyFactory, type PtyProcess } from "./host.js";
import { createTerminalHostClient, TERMINAL_HOST_EXTENSION_ID, TERMINAL_DATA_EVENT, TERMINAL_EXITED_EVENT, TERMINAL_LIST_EVENT } from "./protocol.js";

interface FakePty {
  pty: PtyProcess;
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  output(data: string): void;
  exit(code: number): void;
  options: Parameters<PtyFactory>[0];
}

/** A pty that echoes nothing on its own; the test drives output and exit. */
function fakePtys(): { spawn: ReturnType<typeof vi.fn<PtyFactory>>; processes: FakePty[] } {
  const processes: FakePty[] = [];
  const spawn = vi.fn<PtyFactory>((options) => {
    let onData: (data: string) => void = () => undefined;
    let onExit: (code: number) => void = () => undefined;
    const entry: FakePty = {
      write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
      output: (data) => onData(data),
      exit: (code) => onExit(code),
      options,
      pty: {
        write: (data) => entry.write(data),
        resize: (cols, rows) => entry.resize(cols, rows),
        kill: () => entry.kill(),
        onData: (listener) => { onData = listener; },
        onExit: (listener) => { onExit = listener; },
      },
    };
    processes.push(entry);
    return entry.pty;
  });
  return { spawn, processes };
}

function services(overrides: Partial<HostExtensionServices> = {}): Partial<HostExtensionServices> {
  return {
    cwd: () => "/project",
    knownWorkspacePath: async (path) => {
      if (path === "workspace-one" || path === "/project") return "/project";
      throw new Error(`Unknown workspace ${path}`);
    },
    noteSubprocess: vi.fn(),
    thread: (sessionId) => sessionId === "thread-one"
      ? { sessionId, cwd: "/project/.worktrees/one", isStreaming: () => false, isIdle: () => true } as never
      : undefined,
    registerThreadLifecycle: () => () => undefined,
    ...overrides,
  };
}

describe("terminal host commands", () => {
  it("opens, writes, resizes, replays and observes exit through the public command channel", async () => {
    const { spawn, processes } = fakePtys();
    const events: PublishedKitEvent[] = [];
    const registry = await activateHostKit(createTerminalHostExtension(spawn), services(), (event) => events.push(event));
    const client = createTerminalHostClient((command, input) => registry.invoke(TERMINAL_HOST_EXTENSION_ID, command, input));
    try {
      const session = await client.open({ workspaceId: "workspace-one", sessionId: "thread-one" });
      // The thread runs in its own worktree, so its shell starts there.
      expect(session).toMatchObject({ workspaceId: "workspace-one", sessionId: "thread-one", cwd: "/project/.worktrees/one", cols: 80, rows: 24 });
      expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/project/.worktrees/one", cols: 80, rows: 24, env: expect.objectContaining({ TERM: "xterm-256color" }) }));
      expect(await client.list()).toHaveLength(1);

      await client.input({ id: session.id, data: "echo hi\r" });
      expect(processes[0].write).toHaveBeenCalledWith("echo hi\r");
      processes[0].output("hi\r\n");
      await Promise.resolve();
      // Only the clients drawing this shell watch its topic.
      expect(events).toContainEqual(expect.objectContaining({ name: TERMINAL_DATA_EVENT, payload: { id: session.id, data: "hi\r\n", offset: 4 }, topic: `output/${session.id}` }));
      expect(events.filter((event) => event.name !== TERMINAL_DATA_EVENT).every((event) => event.topic === undefined)).toBe(true);
      expect(await client.replay({ id: session.id })).toEqual({ data: "hi\r\n", offset: 4 });

      // Scrollback keeps the last 5,000 lines; the offset keeps counting so a client never redraws.
      const burst = Array.from({ length: 6_000 }, (_, index) => `line ${index}\n`).join("");
      processes[0].output(burst);
      const replayed = await client.replay({ id: session.id });
      expect(replayed?.offset).toBe(4 + burst.length);
      expect(replayed?.data.split("\n")).toHaveLength(5_001);
      expect(replayed?.data.startsWith("line 1000\n")).toBe(true);

      await client.resize({ id: session.id, cols: 120, rows: 40 });
      expect(processes[0].resize).toHaveBeenCalledWith(120, 40);
      expect((await client.list())[0]).toMatchObject({ cols: 120, rows: 40 });

      // Exit keeps the entry, marked, so the user can read how it ended.
      processes[0].exit(3);
      expect(events).toContainEqual(expect.objectContaining({ name: TERMINAL_EXITED_EVENT, payload: { id: session.id, exitCode: 3 } }));
      expect(await client.list()).toEqual([expect.objectContaining({ id: session.id, exitCode: 3 })]);
      await expect(client.input({ id: session.id, data: "x" })).rejects.toThrow(/has ended/);

      // Restart puts a fresh shell in its place, in the same directory, under a new id.
      const restarted = await client.restart({ id: session.id });
      expect(restarted.id).not.toBe(session.id);
      expect(restarted).toMatchObject({ sessionId: "thread-one", cwd: "/project/.worktrees/one", label: session.label });
      expect(restarted.exitCode).toBeUndefined();
      expect(processes[1].options.cwd).toBe("/project/.worktrees/one");
      expect((await client.list()).map((entry) => entry.id)).toEqual([restarted.id]);

      // Closing an ended shell only drops it; closing a running one kills it.
      processes[1].exit(0);
      await client.kill({ id: restarted.id });
      expect(processes[1].kill).not.toHaveBeenCalled();
      const running = await client.open({});
      await client.kill({ id: running.id });
      expect(processes[2].kill).toHaveBeenCalledOnce();
      expect(await client.list()).toEqual([]);
    } finally {
      await registry.dispose();
    }
  });

  it("names a program running in a shell's foreground, and not the shell itself", async () => {
    const { spawn, processes } = fakePtys();
    const registry = await activateHostKit(createTerminalHostExtension(spawn), services());
    const client = createTerminalHostClient((command, input) => registry.invoke(TERMINAL_HOST_EXTENSION_ID, command, input));
    try {
      const session = await client.open({});
      const shell = String(session.shell);
      let foreground: string | undefined = shell;
      processes[0].pty.foreground = () => foreground;
      expect(await client.foreground({ id: session.id })).toEqual({});
      foreground = "top";
      expect(await client.foreground({ id: session.id })).toEqual({ process: "top" });
      foreground = `-${shell}`;
      expect(await client.foreground({ id: session.id })).toEqual({});
      processes[0].exit(0);
      foreground = "top";
      expect(await client.foreground({ id: session.id })).toEqual({});
    } finally {
      await registry.dispose();
    }
  });

  it("answers with the Ghostty font the host reads", async () => {
    const defaults = { families: ["JetBrains Mono"], size: 16, files: ["/config"], problems: [] };
    const registry = await activateHostKit(createTerminalHostExtension(fakePtys().spawn, { fontDefaults: () => defaults }), services());
    const client = createTerminalHostClient((command, input) => registry.invoke(TERMINAL_HOST_EXTENSION_ID, command, input));
    try {
      expect(await client.font()).toEqual(defaults);
    } finally {
      await registry.dispose();
    }
  });

  it("starts a project terminal in the workspace root and refuses an unknown workspace", async () => {
    const { spawn } = fakePtys();
    const registry = await activateHostKit(createTerminalHostExtension(spawn), services());
    const client = createTerminalHostClient((command, input) => registry.invoke(TERMINAL_HOST_EXTENSION_ID, command, input));
    try {
      const project = await client.open({ workspaceId: "workspace-one" });
      expect(project).toMatchObject({ workspaceId: "workspace-one", cwd: "/project" });
      expect(project.sessionId).toBeUndefined();
      const unnamed = await client.open({});
      expect(unnamed.cwd).toBe("/project");
      await expect(client.open({ workspaceId: "somewhere-else" })).rejects.toThrow(/Unknown workspace/);
      // A thread that is not open has no worktree to name; the workspace folder is where it goes.
      const closed = await client.open({ workspaceId: "workspace-one", sessionId: "thread-gone" });
      expect(closed.cwd).toBe("/project");
    } finally {
      await registry.dispose();
    }
  });

  it("starts the shell Settings names, else the user's own", async () => {
    const { spawn, processes } = fakePtys();
    let values: Record<string, string> = { shell: "/bin/sh" };
    const registry = await activateHostKit(createTerminalHostExtension(spawn), services({ settings: async () => ({ options: {}, values }) }));
    const client = createTerminalHostClient((command, input) => registry.invoke(TERMINAL_HOST_EXTENSION_ID, command, input));
    try {
      expect((await client.open({})).shell).toBe("sh");
      expect(processes[0]!.options.file).toBe("/bin/sh");
      values = {};
      await client.open({});
      // The user's own, or /bin/sh where that one is not on this machine.
      expect([defaultShell(), "/bin/sh"]).toContain(processes[1]!.options.file);
    } finally {
      await registry.dispose();
    }
  });

  it("follows the directory a shell reports, names it by it, and starts a split there", async () => {
    const { spawn, processes } = fakePtys();
    const events: PublishedKitEvent[] = [];
    const registry = await activateHostKit(createTerminalHostExtension(spawn), services(), (event) => events.push(event));
    const client = createTerminalHostClient((command, input) => registry.invoke(TERMINAL_HOST_EXTENSION_ID, command, input));
    const here = mkdtempSync(join(tmpdir(), "tau-terminal-cwd-"));
    try {
      const shell = await client.open({ workspaceId: "workspace-one" });
      await client.open({ workspaceId: "workspace-one", label: "dev server" });
      expect(shell.label).toBe("project — shell");
      events.length = 0;

      processes[0].output(`\u001b]7;file://${encodeURI(here)}\u0007$ `);
      processes[1].output(`\u001b]7;file://${encodeURI(here)}\u0007$ `);
      const [followed, kept] = await client.list();
      expect(followed).toMatchObject({ cwd: "/project", currentCwd: here, label: `${basename(here)} — shell` });
      // A name the caller gave stays.
      expect(kept).toMatchObject({ currentCwd: here, label: "dev server" });
      expect(events.filter((event) => event.name === TERMINAL_LIST_EVENT)).toHaveLength(2);
      // The same report again is no news.
      processes[0].output(`\u001b]7;file://${encodeURI(here)}\u0007`);
      expect(events.filter((event) => event.name === TERMINAL_LIST_EVENT)).toHaveLength(2);

      await client.open({ workspaceId: "workspace-one", from: shell.id });
      expect(processes[2].options.cwd).toBe(here);
      // A directory that is gone, or a shell that never reported one, starts where it would have.
      processes[0].output(`\u001b]7;file://${encodeURI(join(here, "gone"))}\u0007`);
      await client.open({ workspaceId: "workspace-one", from: shell.id });
      expect(processes[3].options.cwd).toBe("/project");

      // A restart starts where the shell first did, under the name that place gives it.
      processes[0].exit(0);
      const restarted = await client.restart({ id: shell.id });
      expect(restarted).toMatchObject({ cwd: "/project", label: "project — shell" });
      expect(restarted.currentCwd).toBeUndefined();
    } finally {
      await registry.dispose();
      rmSync(here, { recursive: true, force: true });
    }
  });

  it("keeps a thread's terminal alive when another thread opens its own", async () => {
    const { spawn, processes } = fakePtys();
    const registry = await activateHostKit(createTerminalHostExtension(spawn), services());
    const client = createTerminalHostClient((command, input) => registry.invoke(TERMINAL_HOST_EXTENSION_ID, command, input));
    try {
      const first = await client.open({ workspaceId: "workspace-one", sessionId: "thread-one" });
      const second = await client.open({ workspaceId: "workspace-one", sessionId: "thread-two" });
      expect(first.id).not.toBe(second.id);
      processes[0].output("still alive");
      expect(await client.replay({ id: first.id })).toMatchObject({ data: "still alive" });
      expect(processes[0].kill).not.toHaveBeenCalled();
      expect((await client.list()).map((session) => session.id)).toEqual([first.id, second.id]);
    } finally {
      await registry.dispose();
    }
  });

  it("closes a workspace's terminals when the host leaves that workspace", async () => {
    const { spawn, processes } = fakePtys();
    let hook: HostThreadLifecycle | undefined;
    const events: PublishedKitEvent[] = [];
    const registry = await activateHostKit(createTerminalHostExtension(spawn), services({
      registerThreadLifecycle: (lifecycle) => { hook = lifecycle; return () => { hook = undefined; }; },
    }), (event) => events.push(event));
    const client = createTerminalHostClient((command, input) => registry.invoke(TERMINAL_HOST_EXTENSION_ID, command, input));
    try {
      await client.open({ workspaceId: "workspace-one", sessionId: "thread-one" });
      await client.open({ workspaceId: "workspace-one" });
      // Another workspace closing says nothing about this one's shells.
      await hook?.afterWorkspaceClose?.("/elsewhere", "switch");
      expect(processes.map((process) => process.kill.mock.calls.length)).toEqual([0, 0]);
      expect(await client.list()).toHaveLength(2);
      // This one closing takes them with it.
      await hook?.afterWorkspaceClose?.("/project", "switch");
      expect(processes.map((process) => process.kill.mock.calls.length)).toEqual([1, 1]);
      expect(await client.list()).toEqual([]);
      expect(events.at(-1)).toMatchObject({ name: TERMINAL_LIST_EVENT, payload: [] });
    } finally {
      await registry.dispose();
    }
    expect(hook).toBeUndefined();
  });

  it("closes the terminals of a thread that was deleted, and only those", async () => {
    const { spawn, processes } = fakePtys();
    let hook: HostThreadLifecycle | undefined;
    const registry = await activateHostKit(createTerminalHostExtension(spawn), services({
      registerThreadLifecycle: (lifecycle) => { hook = lifecycle; return () => { hook = undefined; }; },
    }));
    const client = createTerminalHostClient((command, input) => registry.invoke(TERMINAL_HOST_EXTENSION_ID, command, input));
    try {
      const doomed = await client.open({ workspaceId: "workspace-one", sessionId: "thread-one" });
      const kept = await client.open({ workspaceId: "workspace-one", sessionId: "thread-two" });

      await hook?.threadDeleted?.("thread-one", "/project");

      expect(processes.map((process) => process.kill.mock.calls.length)).toEqual([1, 0]);
      expect((await client.list()).map((session) => session.id)).toEqual([kept.id]);
      expect(doomed.id).not.toBe(kept.id);
    } finally {
      await registry.dispose();
    }
  });

  it("caps the terminals of one workspace", async () => {
    const { spawn } = fakePtys();
    const registry = await activateHostKit(createTerminalHostExtension(spawn), services());
    const client = createTerminalHostClient((command, input) => registry.invoke(TERMINAL_HOST_EXTENSION_ID, command, input));
    try {
      for (let index = 0; index < MAX_SESSIONS_PER_WORKSPACE; index += 1) await client.open({ workspaceId: "workspace-one" });
      await expect(client.open({ workspaceId: "workspace-one" })).rejects.toThrow(/close one first/);
      await expect(client.open({})).rejects.toThrow(/close one first/);
    } finally {
      await registry.dispose();
    }
  });

  it("answers with one sentence when the host has no node-pty", async () => {
    const registry = await activateHostKit(createTerminalHostExtension(), services({
      loadDependency: async () => { throw new Error("Cannot find module 'node-pty'"); },
    }));
    const client = createTerminalHostClient((command, input) => registry.invoke(TERMINAL_HOST_EXTENSION_ID, command, input));
    try {
      await expect(client.open({})).rejects.toThrow(NO_PTY);
      // The kit still answers; nothing was opened.
      expect(await client.list()).toEqual([]);
    } finally {
      await registry.dispose();
    }
  });

  it("does not publish queued output after disposal, and opens nothing more", async () => {
    let emitData: (data: string) => void = () => undefined;
    const emit = vi.fn();
    const sessions = new TerminalSessions(() => ({
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
      onData: (listener) => { emitData = listener; },
      onExit: () => undefined,
    }), emit);
    sessions.open({ workspaceId: "workspace-one", cwd: "/project", root: "/project" });
    emit.mockClear();
    emitData("queued output");
    sessions.dispose();
    await Promise.resolve();
    expect(emit).not.toHaveBeenCalled();
    expect(() => sessions.open({ cwd: "/project", root: "/project" })).toThrow(/shutting down/);
  });

  it("kills remaining processes when the host kit is removed", async () => {
    const { spawn, processes } = fakePtys();
    const registry = await activateHostKit(createTerminalHostExtension(spawn), services());
    const client = createTerminalHostClient((command, input) => registry.invoke(TERMINAL_HOST_EXTENSION_ID, command, input));
    try {
      await client.open({ workspaceId: "workspace-one" });
      await registry.remove(TERMINAL_HOST_EXTENSION_ID);
      expect(processes[0].kill).toHaveBeenCalledOnce();
      await expect(client.list()).rejects.toThrow(/not installed/);
    } finally {
      await registry.dispose();
    }
  });
});

describe("a terminal in a project that limits its agent's network", () => {
  it("says so above the shell's first output, again after a restart, and not in an unlimited project", async () => {
    const { spawn, processes } = fakePtys();
    let network: "any" | "loopback" = "loopback";
    const executionPolicy = { for: vi.fn(async () => ({ network, allowHosts: [], reasons: network === "any" ? [] : ["This project deploys to a server."], sources: ["tau.servers"] })) };
    const registry = await activateHostKit(createTerminalHostExtension(spawn), services({ executionPolicy: executionPolicy as never }));
    const client = createTerminalHostClient((command, input) => registry.invoke(TERMINAL_HOST_EXTENSION_ID, command, input));
    try {
      const session = await client.open({ workspaceId: "workspace-one", sessionId: "thread-one" });
      expect(executionPolicy.for).toHaveBeenCalledWith("/project/.worktrees/one");
      const notice = "\x1b[2mThis project deploys to a server. This terminal is yours and not limited.\x1b[0m\r\n";
      processes[0].output("$ ");
      expect((await client.replay({ id: session.id }))?.data).toBe(`${notice}$ `);
      processes[0].exit(0);
      const restarted = await client.restart({ id: session.id });
      expect((await client.replay({ id: restarted.id }))?.data).toBe(notice);
      network = "any";
      const open = await client.open({ workspaceId: "workspace-one" });
      expect((await client.replay({ id: open.id }))?.data ?? "").toBe("");
    } finally {
      await registry.dispose();
    }
  });
});

describe("loadNodePty", () => {
  it("wraps the module the host resolved and maps its events", async () => {
    const term = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), onData: vi.fn(), onExit: vi.fn() };
    const spawn = vi.fn(() => term);
    const factory = await loadNodePty(async (name) => {
      expect(name).toBe("node-pty");
      return { spawn };
    });
    const pty = factory({ file: "/bin/zsh", args: ["-il"], cwd: "/project", env: { TERM: "xterm-256color" }, cols: 80, rows: 24 });
    expect(spawn).toHaveBeenCalledWith("/bin/zsh", ["-il"], { name: "xterm-256color", cols: 80, rows: 24, cwd: "/project", env: { TERM: "xterm-256color" } });
    const exited = vi.fn();
    pty.onExit(exited);
    (term.onExit.mock.calls[0] as unknown as [(event: { exitCode: number }) => void])[0]({ exitCode: 7 });
    expect(exited).toHaveBeenCalledWith(7);
  });

  it("names the missing module instead of the resolver's error", async () => {
    await expect(loadNodePty(async () => { throw new Error("ENOENT"); })).rejects.toThrow(NO_PTY);
    await expect(loadNodePty(async () => ({}))).rejects.toThrow(NO_PTY);
  });
});
