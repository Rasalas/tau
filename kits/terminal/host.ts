import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { HostExtension, HostExtensionContext } from "tau/host-extension";
import {
  TERMINAL_DATA_EVENT,
  TERMINAL_EXITED_EVENT,
  TERMINAL_HOST_EXTENSION_ID,
  TERMINAL_LIST_EVENT,
  type TerminalDataEvent,
  type TerminalExitedEvent,
  type UiTerminalSession,
} from "./protocol.js";
import { defaultShell, shellArgs, shellAvailable } from "./shell.js";

/**
 * The pty the host half drives, as a shape. `node-pty` arrives through the
 * host's `loadDependency`, so a host without the native module answers with one
 * clear sentence instead of failing to load the kit.
 */
export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (exitCode: number) => void): void;
}

export interface PtySpawnOptions {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export type PtyFactory = (options: PtySpawnOptions) => PtyProcess;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** Scrollback one session keeps for a client that reattaches. */
const REPLAY_BYTES = 256 * 1024;
/** Sessions per workspace: a project terminal and a few thread terminals. */
export const MAX_SESSIONS_PER_WORKSPACE = 8;
export const NO_PTY = "Terminals need node-pty, which this host does not have.";

export interface OpenTerminalInput {
  /** The identity the client sent; the record carries it back so the panel can group by it. */
  workspaceId?: string;
  /** The thread that asked for the terminal, when one did. */
  sessionId?: string;
  /** Where the shell starts: a thread's own worktree, or the workspace root. */
  cwd: string;
  /** The workspace root the session is filed under: capacity and closing count by it, not by the shell's directory. */
  root: string;
  label?: string;
}

interface Session {
  record: UiTerminalSession;
  root: string;
  /** Gone once the shell exited; the record stays so the user can read the end and restart. */
  pty?: PtyProcess;
  /** Recent output, so a reloaded client can redraw where it was. */
  scrollback: string;
  offset: number;
}

/**
 * The session table. Keyed by session id; every record carries the workspace
 * id it belongs to and, when one asked for it, the thread id. A session dies
 * with its workspace (closeWorkspace) or with the kit (dispose), never with
 * the window or client that opened it.
 */
export class TerminalSessions {
  private readonly sessions = new Map<string, Session>();
  /** Output not yet pushed; flushed on a microtask so a burst is one event. */
  private readonly pending = new Map<string, string>();
  private flushScheduled = false;
  private disposed = false;

  constructor(
    private readonly spawn: PtyFactory,
    private readonly emit: (name: string, payload?: unknown) => void,
  ) {}

  list(): UiTerminalSession[] {
    return [...this.sessions.values()].map((session) => ({ ...session.record }));
  }

  /** Starts a shell in `cwd` and files it under `root`. */
  open(input: OpenTerminalInput): UiTerminalSession {
    if (this.disposed) throw new Error("The terminal kit is shutting down; no new terminals.");
    this.assertCapacity(input.root);
    const id = randomUUID();
    const shell = defaultShell();
    const file = shellAvailable(shell) ? shell : "/bin/sh";
    const pty = this.spawn({
      file,
      args: shellArgs(file),
      cwd: input.cwd,
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    });
    const record: UiTerminalSession = {
      id,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      cwd: input.cwd,
      label: input.label?.trim() || `${basename(input.cwd) || "workspace"} — shell`,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
    };
    const session: Session = { record, root: input.root, pty, scrollback: "", offset: 0 };
    this.sessions.set(id, session);
    pty.onData((data) => this.recordData(id, data));
    pty.onExit((exitCode) => this.exited(id, exitCode));
    this.emitSessions();
    return { ...record };
  }

  /** A fresh shell where an ended one was: same place, same label, a new id so a client redraws from zero. */
  restart(id: string): UiTerminalSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Terminal session ${id.slice(0, 8)} is gone.`);
    if (session.pty) throw new Error("This shell is still running.");
    const { record, root } = session;
    this.sessions.delete(id);
    return this.open({
      ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
      ...(record.sessionId ? { sessionId: record.sessionId } : {}),
      cwd: record.cwd ?? root,
      root,
      label: record.label,
    });
  }

  /** What the user typed, straight into the pty. */
  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Terminal session ${id.slice(0, 8)} is gone.`);
    if (!session.pty) throw new Error("This shell has ended; restart it or open a new one.");
    session.pty.write(data);
  }

  /** The renderer measured a new size; the pty follows, the shell reads it. */
  resize(input: { id: string; cols: number; rows: number }): void {
    const session = this.sessions.get(input.id);
    if (!session) return;
    const cols = clampSize(input.cols, DEFAULT_COLS);
    const rows = clampSize(input.rows, DEFAULT_ROWS);
    if (cols === session.record.cols && rows === session.record.rows) return;
    session.record = { ...session.record, cols, rows };
    session.pty?.resize(cols, rows);
    this.emitSessions();
  }

  /** The user closed the tab; a running shell gets SIGHUP through the pty close, an ended one just leaves the list. */
  kill(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    this.pending.delete(id);
    session.pty?.kill();
    this.emitSessions();
  }

  /** Output since the client last listened, or everything if it never did. */
  replay(id: string): { data: string; offset: number } | undefined {
    const session = this.sessions.get(id);
    return session ? { data: session.scrollback, offset: session.offset } : undefined;
  }

  /** Closes every session of one workspace root: the workspace closed. */
  closeWorkspace(root: string): number {
    return this.closeWhere((session) => session.root === root);
  }

  /** Closes every session that is not in `root`: the host moved on to another workspace. */
  closeOthers(root: string): number {
    return this.closeWhere((session) => session.root !== root);
  }

  /** The kit is leaving: every shell dies with it. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending.clear();
    for (const session of [...this.sessions.values()]) {
      this.sessions.delete(session.record.id);
      session.pty?.kill();
    }
  }

  private closeWhere(matches: (session: Session) => boolean): number {
    const ids = [...this.sessions.values()].filter(matches).map((session) => session.record.id);
    for (const id of ids) {
      const session = this.sessions.get(id);
      if (!session) continue;
      this.sessions.delete(id);
      this.pending.delete(id);
      session.pty?.kill();
    }
    if (ids.length > 0) this.emitSessions();
    return ids.length;
  }

  /** A project holds a handful of terminals, not hundreds of strays. */
  private assertCapacity(root: string): void {
    const held = [...this.sessions.values()].filter((session) => session.root === root).length;
    if (held >= MAX_SESSIONS_PER_WORKSPACE) {
      throw new Error(`This workspace already has ${MAX_SESSIONS_PER_WORKSPACE} terminals; close one first.`);
    }
  }

  private recordData(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.offset += data.length;
    session.scrollback = `${session.scrollback}${data}`.slice(-REPLAY_BYTES);
    this.pending.set(id, (this.pending.get(id) ?? "") + data);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  /** One push per session per burst, not one per chunk. */
  private flush(): void {
    this.flushScheduled = false;
    if (this.disposed) return;
    for (const [id, data] of this.pending) {
      const session = this.sessions.get(id);
      if (!session) continue;
      const event: TerminalDataEvent = { id, data, offset: session.offset };
      this.emit(TERMINAL_DATA_EVENT, event);
    }
    this.pending.clear();
  }

  private exited(id: string, exitCode: number): void {
    const session = this.sessions.get(id);
    if (!session || !session.pty) return;
    session.pty = undefined;
    session.record = { ...session.record, exitCode };
    const event: TerminalExitedEvent = { id, exitCode };
    this.emit(TERMINAL_EXITED_EVENT, event);
    this.emitSessions();
  }

  private emitSessions(): void {
    if (this.disposed) return;
    this.emit(TERMINAL_LIST_EVENT, this.list());
  }
}

function clampSize(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.round(value), 2), 500);
}

/** The slice of node-pty the factory uses; the module is loaded by name, so its shape is checked here. */
interface NodePtyModule {
  spawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }): {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
    onData(listener: (data: string) => void): unknown;
    onExit(listener: (event: { exitCode: number }) => void): unknown;
  };
}

function isNodePtyModule(value: unknown): value is NodePtyModule {
  return typeof (value as Partial<NodePtyModule> | null)?.spawn === "function";
}

/**
 * Wraps the native pty the host resolved. `node-pty` must stay where npm put
 * it: it launches a `spawn-helper` beside its own binary, which a copy inside
 * the kit's bundle would no longer find, so the host loads it (`loadDependency`).
 */
export async function loadNodePty(loadDependency: (name: string) => Promise<unknown>): Promise<PtyFactory> {
  let pty: unknown;
  try {
    pty = await loadDependency("node-pty");
  } catch {
    throw new Error(NO_PTY);
  }
  if (!isNodePtyModule(pty)) throw new Error(NO_PTY);
  const module = pty;
  return (options) => {
    const term = module.spawn(options.file, options.args, {
      name: "xterm-256color",
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: options.env,
    });
    return {
      write: (data) => term.write(data),
      resize: (cols, rows) => term.resize(cols, rows),
      kill: () => term.kill(),
      onData: (listener) => { term.onData(listener); },
      onExit: (listener) => { term.onExit(({ exitCode }) => listener(exitCode)); },
    };
  };
}

/**
 * Terminal Kit's host entry: pty sessions per workspace, the commands the
 * panel calls, and the pushes the panel renders from. The shell dies with the
 * workspace or the kit, never with the window.
 */
export function createTerminalHostExtension(spawn?: PtyFactory): HostExtension {
  return {
    id: TERMINAL_HOST_EXTENSION_ID,
    name: "Terminal",
    permissions: ["workspace:read", "process", "sessions"],
    activate(context: HostExtensionContext) {
      // The native module is resolved on the first open, not at activation:
      // a host without it still activates the kit and answers with the reason.
      let factory: Promise<PtyFactory> | undefined = spawn ? Promise.resolve(spawn) : undefined;
      const ptyFactory = () => {
        factory ??= loadNodePty((name) => context.services.loadDependency(name)).catch((error: unknown) => {
          factory = undefined;
          throw error;
        });
        return factory;
      };
      let resolved: PtyFactory | undefined;
      const sessions = new TerminalSessions((options) => {
        if (!resolved) throw new Error(NO_PTY);
        return resolved(options);
      }, context.emit);

      const open = async (input: Record<string, unknown>): Promise<UiTerminalSession> => {
        resolved = await ptyFactory();
        const workspaceId = typeof input.workspaceId === "string" && input.workspaceId ? input.workspaceId : undefined;
        const sessionId = typeof input.sessionId === "string" && input.sessionId ? input.sessionId : undefined;
        // A terminal belongs to the workspace the host has open now: that is
        // the root `beforeWorkspace` later names when the host moves on.
        const root = context.services.cwd();
        // The workspace id the client sent is an identity the host published;
        // resolve it to the folder the shell may start in, and refuse anything else.
        const start = workspaceId ? await context.services.knownWorkspacePath(workspaceId) : root;
        // A thread the Workspace Kit started in its own worktree names its
        // checkout in `cwd`; that, not the project root, is where its terminal
        // belongs. A thread that is not open falls back to the workspace folder.
        const thread = sessionId ? context.services.thread(sessionId) : undefined;
        const session = sessions.open({
          ...(workspaceId ? { workspaceId } : {}),
          ...(sessionId ? { sessionId } : {}),
          cwd: thread?.cwd ?? start,
          root,
          ...(typeof input.label === "string" ? { label: input.label } : {}),
        });
        context.services.noteSubprocess();
        return session;
      };

      context.registerCommand("open", (raw) => open(fields(raw)));
      context.registerCommand("restart", async (raw) => {
        const session = sessions.restart(String(fields(raw).id));
        context.services.noteSubprocess();
        return session;
      });
      context.registerCommand("input", (raw) => {
        const input = fields(raw);
        sessions.write(String(input.id), String(input.data ?? ""));
      });
      context.registerCommand("resize", (raw) => {
        const input = fields(raw);
        sessions.resize({ id: String(input.id), cols: Number(input.cols), rows: Number(input.rows) });
      });
      context.registerCommand("kill", (raw) => {
        sessions.kill(String(fields(raw).id));
      });
      context.registerCommand("list", () => sessions.list());
      context.registerCommand("replay", (raw) => sessions.replay(String(fields(raw).id)));

      // Terminals die with their workspace: when the host opens another one,
      // the shells of the one it leaves are closed. The hook is the only word
      // the host gives about a workspace change, and it names the new root.
      const unhook = context.services.registerThreadLifecycle({
        beforeWorkspace: async (cwd) => {
          const closed = sessions.closeOthers(cwd);
          if (closed > 0) context.services.log("terminal.workspace-closed", `${closed} terminal(s) closed with the previous workspace`);
        },
      });
      return () => {
        unhook();
        sessions.dispose();
      };
    },
  };
}

function fields(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? input as Record<string, unknown> : {};
}

export default createTerminalHostExtension;
