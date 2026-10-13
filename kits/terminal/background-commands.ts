import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { Type } from "typebox";
import { executionPolicyRefusal, spawnOwnedProcess, type HostExtensionServices, type HostMcpTool, type RuntimeSessionInfo, type ThreadBackgroundCapability } from "tau/host-extension";
import { BackgroundTasks } from "../_shared/background-tasks.js";
import { defaultShell, shellAvailable } from "./shell.js";

const OUTPUT_BYTES = 128 * 1024;
const MAX_COMMANDS = 32;
interface Command { child: ChildProcess; output: Buffer; exitCode?: number; error?: string; stopped: boolean; closed: boolean; done: Promise<void> }
interface Thread { tasks: BackgroundTasks; commands: Map<string, Command> }

/** Each command belongs to the host through a guardian, independent of the agent's current turn. */
export class BackgroundCommands {
  private readonly threads = new Map<string, Thread>();
  constructor(private readonly changed: (threadId: string) => void, private readonly ended: (threadId: string, text: string) => void) {}

  private thread(id: string): Thread {
    let thread = this.threads.get(id);
    if (!thread) { thread = { tasks: new BackgroundTasks(), commands: new Map() }; this.threads.set(id, thread); }
    return thread;
  }
  capability(id: string): ThreadBackgroundCapability {
    return { current: () => this.threads.get(id)?.tasks.current() ?? [], release: (taskId) => {
      const thread = this.threads.get(id);
      if (!thread) throw new Error("That tracked command is no longer available.");
      thread.tasks.release(taskId); this.changed(id);
    }, read: (taskId) => {
      const command = this.threads.get(id)?.commands.get(taskId);
      if (!command) throw new Error("That tracked command is no longer available.");
      return { output: command.output.toString("utf8"), ...(command.exitCode === undefined ? {} : { exitCode: command.exitCode }), ...(command.error ? { error: command.error } : {}) };
    }, stop: async (taskId) => {
      const thread = this.threads.get(id);
      if (!thread) { if (taskId) throw new Error("That tracked command is no longer available."); return; }
      const ids = taskId ? [taskId] : thread.tasks.current().map((task) => task.id);
      for (const target of ids) {
        const command = thread.commands.get(target);
        if (!command) throw new Error("That tracked command is no longer available.");
        command.stopped = true;
        if (!command.closed) {
          this.kill(command);
          const timer = setTimeout(() => this.kill(command, "SIGKILL"), 2_000);
          try { await command.done; } finally { clearTimeout(timer); }
        }
        thread.tasks.forget(target);
        thread.commands.delete(target);
      }
      this.changed(id);
    } };
  }

  async start(threadId: string, cwd: string, command: string, label: string, signal?: AbortSignal, kind: "command" | "monitor" = "command"): Promise<string> {
    if (signal?.aborted) throw new Error("The command start was cancelled.");
    if (!(await stat(cwd)).isDirectory()) throw new Error("The command's workspace is not a directory.");
    if (signal?.aborted) throw new Error("The command start was cancelled.");
    const thread = this.thread(threadId);
    if (thread.tasks.current().length >= MAX_COMMANDS) throw new Error("At most 32 tracked background commands may belong to a thread.");
    const id = `tau-command:${randomUUID()}`;
    const configured = defaultShell();
    const shell = shellAvailable(configured) ? configured : "/bin/sh";
    const args = process.platform === "win32" ? /(?:pwsh|powershell)(?:\.exe)?$/iu.test(shell) ? ["-NoLogo", "-NonInteractive", "-Command", command] : ["/d", "/s", "/c", command] : ["-lc", command];
    const child = spawnOwnedProcess({ command: shell, args, cwd, env: process.env });
    child.stdin.end();
    let resolve!: () => void;
    const entry: Command = { child, output: Buffer.alloc(0), stopped: false, closed: false, done: new Promise<void>((done) => { resolve = done; }) };
    thread.commands.set(id, entry);
    thread.tasks.start({ id, kind, label, startedAt: Date.now() });
    const data = (chunk: Buffer) => { entry.output = Buffer.concat([entry.output, chunk]).subarray(-OUTPUT_BYTES); };
    child.stdout!.on("data", data);
    child.stderr!.on("data", data);
    child.on("error", (error) => { entry.error = error.message; });
    child.once("close", (code, exitSignal) => {
      entry.closed = true;
      if (code !== null) entry.exitCode = code;
      else entry.error ??= `Command ended with ${exitSignal ?? "no exit status"}.`;
      resolve();
      if (entry.stopped || !thread.tasks.has(id)) return;
      thread.tasks.report(id);
      if (!thread.tasks.has(id)) thread.commands.delete(id);
      this.changed(threadId);
      const output = entry.output.toString("utf8").split("\n").slice(-20).join("\n");
      this.ended(threadId, `The tracked background command ${JSON.stringify(label)} ended${code === null ? ": " + entry.error : " with exit code " + code}.\nTask ID: ${id}\n${output}`);
    });
    try {
      await new Promise<void>((ready, reject) => { child.once("spawn", ready); child.once("error", reject); });
    } catch (error) {
      entry.stopped = true;
      thread.tasks.forget(id);
      thread.commands.delete(id);
      throw error;
    }
    this.changed(threadId);
    return id;
  }

  snapshot(threadId: string): Map<string, number> { return this.threads.get(threadId)?.tasks.snapshot() ?? new Map(); }
  handled(threadId: string, snapshot: ReadonlyMap<string, number>): void {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    if (thread.tasks.handled(snapshot)) this.changed(threadId);
    // Output is retained only while its task remains visible; bound memory by the open task limit.
    for (const [id, command] of thread.commands) if (command.closed && !thread.tasks.has(id)) thread.commands.delete(id);
  }
  async close(threadId: string): Promise<void> { await this.capability(threadId).stop(); this.threads.delete(threadId); }
  async dispose(): Promise<void> { await Promise.all([...this.threads.keys()].map((id) => this.close(id))); }
  private kill(command: Command, signal: NodeJS.Signals = "SIGTERM"): void {
    command.child.kill(signal);
  }
}

const INSTRUCTIONS = "For a command that must outlive your reply, use tau_background_command. Tau tracks its real process, captures output and wakes you when it ends. Do not detach commands with shell background operators or nohup. Tests and builds remain required. Check a long-lived service is ready before releasing its task through tau_background_tasks. Read tracked output with tau_background_tasks action read.";

export function registerBackgroundCommands(services: HostExtensionServices): () => Promise<void> {
  if (!services.background) return async () => undefined;
  const manager = new BackgroundCommands((id) => services.background!.changed(id), (id, text) => {
    void services.sessions.send?.(id, text, { delivery: "queue", wake: { source: "background", label: "Background command ended" } }).catch((error: unknown) => services.log("background.wake-failed", error instanceof Error ? error.message : String(error)));
  });
  const tools = (session: RuntimeSessionInfo): HostMcpTool[] => [{
    name: "tau_background_command", label: "Start tracked background command", description: "Start a command in this thread's workspace, tracked by Tau until its process exits and you handle the result. Returns a task ID immediately. Use for tests, builds, installs, watches and services that outlive a reply. Do not detach again inside the command. Read, stop or release it with tau_background_tasks.",
    annotations: { readOnlyHint: false },
    parameters: Type.Object({ command: Type.String({ minLength: 1 }), label: Type.String({ minLength: 1 }), kind: Type.Optional(Type.Union([Type.Literal("command"), Type.Literal("monitor")])) }),
    execute: async (_id, input: { command: string; label: string; kind?: "command" | "monitor" }, signal) => {
      const thread = services.thread(session.sessionId);
      if (!thread || thread.cwd !== session.cwd) throw new Error("The thread's workspace is no longer available.");
      if (!services.sessions.send) throw new Error("This machine cannot deliver command results to the thread.");
      const refusal = executionPolicyRefusal(await services.executionPolicy?.for(thread.cwd), "Tracked background commands");
      if (refusal) throw new Error(refusal);
      services.noteSubprocess();
      const taskId = await manager.start(thread.sessionId, thread.cwd, input.command, input.label, signal, input.kind);
      return { content: [{ type: "text", text: JSON.stringify({ taskId, blocksCompletion: true }) }], details: { taskId } };
    },
  }];
  const snapshots = new Map<string, Map<string, number>>();
  const key = (id: string, turnId: string) => JSON.stringify([id, turnId]);
  const releases = [
    services.background.provide((id) => manager.capability(id)),
    services.mcp.registerTools(tools),
    services.mcp.registerInstructions?.(() => INSTRUCTIONS) ?? (() => undefined),
    services.registerRuntimeExtension("tau-background-command", (pi, session) => {
      for (const tool of tools(session)) pi.registerTool(tool);
      pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${INSTRUCTIONS}` }));
    }),
    services.registerTurnObserver({
      prepare: async (id, turnId) => { snapshots.set(key(id, turnId), manager.snapshot(id)); },
      ended: async (id, turnId, outcome) => { const snapshot = snapshots.get(key(id, turnId)); snapshots.delete(key(id, turnId)); if (outcome === "completed" && snapshot) manager.handled(id, snapshot); },
      cancelled: async (id, turnId) => { snapshots.delete(key(id, turnId)); },
      closed: async (id) => { await manager.close(id); },
    }),
    services.registerThreadLifecycle({ threadDeleted: async (id) => { await manager.close(id); } }),
  ];
  return async () => { await manager.dispose(); for (const release of releases.reverse()) release(); };
}
