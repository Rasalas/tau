import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { killProcessTree } from "tau/host-extension";
import { RUN_DISMISSED_EVENT, RUN_EVENT, type ProjectScript, type UiScriptRun } from "./protocol.js";

/** A started script, as a shape: the test drives a fake, the host a child process. */
export interface ScriptProcess {
  onOutput(listener: (text: string) => void): void;
  onExit(listener: (exitCode: number | null, signal: string | null) => void): void;
  /** Ends the script and everything it started. */
  kill(): void;
}

export interface ScriptSpawnOptions {
  command: string;
  cwd: string;
  env: Record<string, string>;
}

export type ScriptSpawner = (options: ScriptSpawnOptions) => ScriptProcess;

/** Answers whether a URL takes connections; any HTTP answer counts. */
export type UrlProbe = (url: string) => Promise<boolean>;

/** Output one run keeps; the card shows the end of it. */
export const OUTPUT_LIMIT = 64 * 1024;
/** Finished runs kept for their cards; the oldest go first. */
export const FINISHED_LIMIT = 20;
const OUTPUT_FLUSH_MS = 100;
const KILL_GRACE_MS = 3_000;
const PREVIEW_POLL_MS = 300;
const PREVIEW_WAIT_MS = 30_000;

/**
 * `sh -c` in the host's environment, which already is the login shell's. The
 * script leads a process group of its own: stopping a dev server also stops
 * what `npm run` started under it. Windows runs it through `cmd.exe` and ends
 * the tree with `taskkill /T`, having no process groups.
 */
export const spawnScript: ScriptSpawner = ({ command, cwd, env }) => {
  const windows = process.platform === "win32";
  const child = windows
    ? spawn(command, { cwd, env, shell: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    : spawn("/bin/sh", ["-c", command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let exited = false;
  let output: (text: string) => void = () => undefined;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (exited || child.pid === undefined) return;
    killProcessTree(child.pid, signal);
  };
  return {
    onOutput: (listener) => {
      output = listener;
      child.stdout?.setEncoding("utf8").on("data", listener);
      child.stderr?.setEncoding("utf8").on("data", listener);
    },
    onExit: (listener) => {
      child.on("error", (error) => {
        if (exited) return;
        exited = true;
        output(`${error.message}\n`);
        listener(127, null);
      });
      child.on("close", (code, signal) => {
        if (exited) return;
        exited = true;
        listener(code, signal);
      });
    },
    kill: () => {
      signalGroup("SIGTERM");
      setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS).unref();
    },
  };
};

/** Any HTTP answer, even a 404, means the server is listening. */
export const probeUrl: UrlProbe = async (url) => {
  try {
    const response = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(1_000) });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
};

export interface ScriptRunsOptions {
  spawn: ScriptSpawner;
  emit(name: string, payload?: unknown): void;
  probe?: UrlProbe;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  onSpawn?(): void;
}

export interface StartRunInput {
  script: ProjectScript;
  directory: string;
  /** The workspace root the run is filed under; it ends when the host leaves that workspace. */
  root: string;
  sessionId?: string;
  trigger: UiScriptRun["trigger"];
  env?: Record<string, string>;
}

interface Run {
  record: UiScriptRun;
  root: string;
  process?: ScriptProcess;
  flushTimer?: ReturnType<typeof setTimeout>;
  /** Asked to stop; the status says so once the process is gone. */
  stopping?: boolean;
  finished: Promise<UiScriptRun>;
  settle(record: UiScriptRun): void;
}

/**
 * Every script run the host holds. A run is a job: it answers with its record
 * at once, pushes the output as it comes, and pushes once more with the exit
 * code. A long-lived one — a dev server — simply stays running.
 */
export class ScriptRuns {
  private readonly runs = new Map<string, Run>();
  private disposed = false;

  constructor(private readonly options: ScriptRunsOptions) {}

  list(): UiScriptRun[] {
    return [...this.runs.values()].map((run) => ({ ...run.record }));
  }

  /** The running run of a script in a directory, if one is. */
  running(scriptId: string, directory: string): UiScriptRun | undefined {
    const run = [...this.runs.values()].find((candidate) => candidate.record.status === "running" && candidate.record.scriptId === scriptId && candidate.record.directory === directory);
    return run ? { ...run.record } : undefined;
  }

  start(input: StartRunInput): UiScriptRun {
    if (this.disposed) throw new Error("Project Scripts is shutting down; no new runs.");
    const { script } = input;
    const now = this.options.now ?? Date.now;
    const record: UiScriptRun = {
      id: randomUUID(),
      scriptId: script.id,
      name: script.name,
      command: script.command,
      icon: script.icon,
      directory: input.directory,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      trigger: input.trigger,
      status: "running",
      startedAt: now(),
      output: "",
      outputLength: 0,
      ...(script.previewUrl ? { previewUrl: script.previewUrl } : {}),
      autoOpenPreview: script.autoOpenPreview,
    };
    let settle: (record: UiScriptRun) => void = () => undefined;
    const finished = new Promise<UiScriptRun>((resolve) => { settle = resolve; });
    const run: Run = { record, root: input.root, finished, settle };
    this.runs.set(record.id, run);
    this.trimFinished();
    try {
      run.process = this.options.spawn({
        command: script.command,
        cwd: input.directory,
        env: { ...stringEnv(this.options.env ?? process.env), TAU_SCRIPT_ID: script.id, ...(input.env ?? {}) },
      });
    } catch (error) {
      this.append(run, `${error instanceof Error ? error.message : String(error)}\n`);
      this.finish(run, 127, null);
      return { ...run.record };
    }
    this.options.onSpawn?.();
    run.process.onOutput((text) => this.append(run, text));
    run.process.onExit((code, signal) => this.finish(run, code, signal));
    this.emit(run);
    if (script.previewUrl) void this.waitForPreview(run, script.previewUrl);
    return { ...run.record };
  }

  /** Resolves with the final record once the run ended. */
  finished(runId: string): Promise<UiScriptRun> {
    const run = this.runs.get(runId);
    return run ? run.finished : Promise.reject(new Error(`Run ${runId.slice(0, 8)} is gone.`));
  }

  stop(runId: string): void {
    const run = this.runs.get(runId);
    if (!run || run.record.status !== "running" || run.stopping) return;
    run.stopping = true;
    run.process?.kill();
  }

  /** Forgets a finished run; a running one has to be stopped first. */
  dismiss(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    if (run.record.status === "running") throw new Error("Stop the script before dismissing it.");
    this.runs.delete(runId);
    this.options.emit(RUN_DISMISSED_EVENT, { id: runId });
  }

  /** Stops every run filed under a workspace root: the host left it. */
  stopWorkspace(root: string): number {
    const running = [...this.runs.values()].filter((run) => run.root === root && run.record.status === "running" && !run.stopping);
    for (const run of running) this.stop(run.record.id);
    return running.length;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const run of this.runs.values()) {
      if (run.flushTimer) clearTimeout(run.flushTimer);
      if (run.record.status === "running") run.process?.kill();
    }
  }

  private append(run: Run, text: string): void {
    const output = `${run.record.output}${text}`;
    run.record = {
      ...run.record,
      output: output.length > OUTPUT_LIMIT ? output.slice(-OUTPUT_LIMIT) : output,
      outputLength: run.record.outputLength + text.length,
    };
    // A chatty script is one push per interval, not one per chunk.
    run.flushTimer ??= setTimeout(() => {
      run.flushTimer = undefined;
      this.emit(run);
    }, OUTPUT_FLUSH_MS);
  }

  private finish(run: Run, code: number | null, signal: string | null): void {
    if (run.record.endedAt !== undefined) return;
    if (run.flushTimer) clearTimeout(run.flushTimer);
    run.flushTimer = undefined;
    const status = run.stopping ? "stopped" : code === 0 ? "succeeded" : "failed";
    run.record = {
      ...run.record,
      status,
      ...(code === null ? {} : { exitCode: code }),
      ...(signal ? { signal } : {}),
      endedAt: (this.options.now ?? Date.now)(),
    };
    run.process = undefined;
    this.emit(run);
    run.settle({ ...run.record });
    this.trimFinished();
  }

  private async waitForPreview(run: Run, url: string): Promise<void> {
    const probe = this.options.probe ?? probeUrl;
    const deadline = (this.options.now ?? Date.now)() + PREVIEW_WAIT_MS;
    while (!this.disposed && run.record.status === "running") {
      if (await probe(url)) break;
      if ((this.options.now ?? Date.now)() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, PREVIEW_POLL_MS));
    }
    if (this.disposed || run.record.status !== "running" || !this.runs.has(run.record.id)) return;
    run.record = { ...run.record, previewReady: true };
    this.emit(run);
  }

  private trimFinished(): void {
    const finished = [...this.runs.values()].filter((run) => run.record.status !== "running");
    for (const run of finished.slice(0, Math.max(0, finished.length - FINISHED_LIMIT))) this.runs.delete(run.record.id);
  }

  private emit(run: Run): void {
    if (this.disposed) return;
    this.options.emit(RUN_EVENT, { ...run.record });
  }
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
