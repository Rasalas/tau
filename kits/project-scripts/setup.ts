import { randomUUID } from "node:crypto";
import type { ProjectScript, UiScriptRun, UiSetupStage, UiWorktreeSetup } from "./protocol.js";

/** Lines of a script's output the card keeps; the box is sized for exactly these. */
export const SETUP_TAIL_LINES = 4;
const TAIL_LINE_LENGTH = 400;
/** Settled setups kept for their cards; the oldest go first. */
export const SETUP_LIMIT = 20;

// oxlint-disable-next-line eslint/no-control-regex -- ESC and BEL delimit the colour codes this strips.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/gu;

/** The last lines a script printed, colour codes stripped, as the card shows them. */
export function outputTail(output: string): string[] {
  return output.replace(ANSI, "").split(/\r?\n|\r/u).map((line) => line.trimEnd()).filter((line) => line.length > 0)
    .slice(-SETUP_TAIL_LINES)
    .map((line) => line.length > TAIL_LINE_LENGTH ? `${line.slice(0, TAIL_LINE_LENGTH - 1)}…` : line);
}

/** The steps Workspace Kit reports, in the order they run. */
export const GIT_STAGES = ["fetch", "checkout", "submodules"] as const;
export type SetupGitStage = typeof GIT_STAGES[number];

export interface SetupTrackerOptions {
  emit(setup: UiWorktreeSetup): void;
  now?: () => number;
}

interface Tracked {
  setup: UiWorktreeSetup;
  /** Resolves the wait of a blocking setup: the thread may start. */
  release(): void;
  released: Promise<void>;
  cancelled: boolean;
  runs: Map<string, string>;
}

/**
 * The worktree setup of a new thread, one step at a time: fetching the base,
 * creating the checkout, then every `runOnWorktreeCreate` script. It lives in
 * memory, like T3 Code's tracker; the durable record is the worktree and the
 * script runs. Workspace Kit reports the Git steps, the script runs report
 * themselves.
 */
export class SetupTracker {
  private readonly setups = new Map<string, Tracked>();

  constructor(private readonly options: SetupTrackerOptions) {}

  private now() { return (this.options.now ?? Date.now)(); }

  list(): UiWorktreeSetup[] {
    return [...this.setups.values()].map((tracked) => clone(tracked.setup));
  }

  get(id: string): UiWorktreeSetup | undefined {
    const tracked = this.setups.get(id);
    return tracked ? clone(tracked.setup) : undefined;
  }

  begin(input: { project: string; branch?: string; scripts: readonly ProjectScript[] }): UiWorktreeSetup {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const setup: UiWorktreeSetup = {
      id: randomUUID(),
      project: input.project,
      ...(input.branch ? { branch: input.branch } : {}),
      phase: "running",
      startedAt: this.now(),
      stages: [
        stage("fetch", "Fetch base branch"),
        stage("checkout", "Create worktree"),
        ...input.scripts.map((script) => ({ ...stage(`script:${script.id}`, script.name), command: script.command, async: script.async })),
      ],
    };
    this.setups.set(setup.id, { setup, release, released, cancelled: false, runs: new Map() });
    this.trim();
    this.publish(setup.id);
    return clone(setup);
  }

  /**
   * A Git step began; the one before it is done, or was never needed. The
   * submodule step only shows for a checkout that has submodules, and its
   * failure does not fail the setup.
   */
  step(id: string, stageId: SetupGitStage, detail?: string, failed = false): void {
    this.update(id, (setup) => {
      const at = this.now();
      const index = GIT_STAGES.indexOf(stageId);
      if (stageId === "submodules" && !setup.stages.some((entry) => entry.id === "submodules")) {
        const after = setup.stages.findIndex((entry) => entry.id === "checkout");
        setup.stages.splice(after + 1, 0, stage("submodules", "Initialize submodules"));
      }
      setup.stages = setup.stages.map((entry) => {
        const position = GIT_STAGES.indexOf(entry.id as SetupGitStage);
        if (position < 0) return entry;
        if (position < index) return settle(entry, entry.status === "running" ? "done" : entry.status === "pending" ? "skipped" : entry.status, at);
        if (position === index && failed) return settle({ ...entry, ...(detail ? { detail } : {}) }, "failed", at);
        if (position === index) return { ...entry, status: "running", startedAt: at, ...(detail ? { detail } : {}) };
        return entry;
      });
    });
  }

  /** The checkout exists; the scripts come next. */
  created(id: string, worktree: string): void {
    this.update(id, (setup) => {
      const at = this.now();
      setup.worktree = worktree;
      setup.stages = setup.stages.map((entry) => GIT_STAGES.includes(entry.id as SetupGitStage)
        ? settle(entry, entry.status === "pending" ? (entry.id === "checkout" ? "done" : "skipped") : entry.status === "running" ? "done" : entry.status, at)
        : entry);
    });
  }

  /** The worktree could not be made; nothing else runs. */
  failed(id: string, error: string): void {
    this.update(id, (setup) => {
      const at = this.now();
      setup.phase = "failed";
      setup.endedAt = at;
      setup.error = error.slice(0, 1_000);
      setup.stages = setup.stages.map((entry) => entry.status === "running" ? settle(entry, "failed", at) : entry.status === "pending" ? settle(entry, "skipped", at) : entry);
    });
    this.setups.get(id)?.release();
  }

  /** A script of this setup started as a run; its pushes move the stage from now on. */
  attach(id: string, scriptId: string, run: UiScriptRun): void {
    const tracked = this.setups.get(id);
    if (!tracked) return;
    tracked.runs.set(run.id, `script:${scriptId}`);
    this.runChanged(run);
  }

  runChanged(run: UiScriptRun): void {
    for (const [id, tracked] of this.setups) {
      const stageId = tracked.runs.get(run.id);
      if (!stageId) continue;
      this.update(id, (setup) => {
        setup.stages = setup.stages.map((entry) => {
          if (entry.id !== stageId) return entry;
          const status = run.status === "running" ? "running" : run.status === "succeeded" ? "done" : run.status === "stopped" ? "skipped" : "failed";
          return {
            ...entry,
            status,
            runId: run.id,
            startedAt: run.startedAt,
            ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
            tail: outputTail(run.output),
            ...(run.status === "failed" ? { detail: run.exitCode === undefined ? run.signal ?? "failed" : `exit ${run.exitCode}` } : {}),
            ...(run.status === "stopped" ? { detail: "cancelled" } : {}),
          };
        });
      });
      return;
    }
  }

  isCancelled(id: string): boolean {
    return this.setups.get(id)?.cancelled ?? false;
  }

  /** Resolves when the thread may start: every blocking step ended, or the user stopped waiting. */
  released(id: string): Promise<void> {
    return this.setups.get(id)?.released ?? Promise.resolve();
  }

  /** The user starts the thread now; blocking scripts go on in the background. */
  release(id: string): boolean {
    const tracked = this.setups.get(id);
    if (!tracked || tracked.setup.phase !== "running" || tracked.setup.released) return false;
    this.update(id, (setup) => { setup.released = true; });
    tracked.release();
    return true;
  }

  /** Stops the setup: running scripts are stopped by the caller, the rest never start. Answers the runs to stop. */
  cancel(id: string): string[] {
    const tracked = this.setups.get(id);
    if (!tracked || tracked.setup.phase !== "running") return [];
    tracked.cancelled = true;
    const running = tracked.setup.stages.filter((entry) => entry.status === "running" && entry.runId).map((entry) => entry.runId as string);
    this.update(id, (setup) => {
      const at = this.now();
      setup.stages = setup.stages.map((entry) => entry.status === "pending" ? settle({ ...entry, detail: "cancelled" }, "skipped", at) : entry);
    });
    tracked.release();
    return running;
  }

  /** Every script ran or was skipped: the setup is over. */
  finish(id: string): void {
    const tracked = this.setups.get(id);
    if (!tracked || tracked.setup.phase !== "running") return;
    this.update(id, (setup) => {
      const at = this.now();
      setup.phase = tracked.cancelled ? "cancelled" : "done";
      setup.endedAt = at;
      setup.stages = setup.stages.map((entry) => entry.status === "pending" ? settle(entry, "skipped", at) : entry);
    });
    tracked.release();
  }

  dismiss(id: string): boolean {
    const tracked = this.setups.get(id);
    if (!tracked || tracked.setup.phase === "running") return false;
    this.setups.delete(id);
    return true;
  }

  private update(id: string, mutate: (setup: UiWorktreeSetup) => void): void {
    const tracked = this.setups.get(id);
    if (!tracked) return;
    const next = clone(tracked.setup);
    mutate(next);
    tracked.setup = next;
    this.publish(id);
  }

  private publish(id: string): void {
    const tracked = this.setups.get(id);
    if (tracked) this.options.emit(clone(tracked.setup));
  }

  private trim(): void {
    const settled = [...this.setups.values()].filter((tracked) => tracked.setup.phase !== "running");
    for (const tracked of settled.slice(0, Math.max(0, this.setups.size - SETUP_LIMIT))) this.setups.delete(tracked.setup.id);
  }
}

function stage(id: string, label: string): UiSetupStage {
  return { id, label, status: "pending", tail: [] };
}

function settle(entry: UiSetupStage, status: UiSetupStage["status"], at: number): UiSetupStage {
  if (status === entry.status && entry.endedAt !== undefined) return entry;
  return { ...entry, status, ...(status === "running" || status === "pending" ? {} : { endedAt: entry.endedAt ?? at }) };
}

function clone(setup: UiWorktreeSetup): UiWorktreeSetup {
  return { ...setup, stages: setup.stages.map((entry) => ({ ...entry, tail: [...entry.tail] })) };
}
