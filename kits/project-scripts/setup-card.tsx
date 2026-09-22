import { useEffect, useState, useSyncExternalStore } from "react";
import { Check, ChevronDown, ChevronRight, Circle, Minus, Play, X } from "lucide-react";
import { errorMessage, type RegionProps, type WorkbenchActions } from "tau";
import type { ProjectScriptsHostClient, UiSetupStage, UiWorktreeSetup } from "./protocol.js";

/** Worktree setups the host pushes, newest first. One per activation. */
export class SetupStore {
  private setups: UiWorktreeSetup[] = [];
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): readonly UiWorktreeSetup[] => this.setups;

  apply(setup: UiWorktreeSetup): void {
    this.set([setup, ...this.setups.filter((entry) => entry.id !== setup.id)].sort((left, right) => right.startedAt - left.startedAt));
  }

  remove(id: string): void {
    if (this.setups.some((entry) => entry.id === id)) this.set(this.setups.filter((entry) => entry.id !== id));
  }

  load(setups: unknown): void {
    if (!Array.isArray(setups)) return;
    for (const setup of setups as UiWorktreeSetup[]) this.apply(setup);
  }

  private set(next: UiWorktreeSetup[]): void {
    this.setups = next;
    for (const listener of [...this.listeners]) listener();
  }
}

const trimmed = (path: string | undefined) => path?.replace(/[\\/]+$/u, "");

/** A clean finish leaves the transcript, as in T3 Code; failures and cancels stay until dismissed. */
export function worthShowing(setup: UiWorktreeSetup): boolean {
  if (setup.phase !== "done") return true;
  return setup.stages.some((stage) => stage.status === "failed");
}

/**
 * The setups that belong to what is on screen: while a new thread's first
 * prompt waits, the running setup of the checkout it was started from; once
 * the thread runs in its worktree, that worktree's.
 */
export function setupsOnScreen(setups: readonly UiWorktreeSetup[], screen: { cwd?: string; draftPending: boolean }): UiWorktreeSetup[] {
  const cwd = trimmed(screen.cwd);
  if (!cwd) return [];
  return setups.filter((setup) => worthShowing(setup) && (screen.draftPending
    ? setup.phase === "running" && !setup.released && trimmed(setup.project) === cwd
    : trimmed(setup.worktree) === cwd));
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function headline(setup: UiWorktreeSetup): string {
  if (setup.phase === "running") return setup.released ? "Setting up worktree in the background…" : "Setting up worktree…";
  if (setup.phase === "failed") return "Worktree setup failed";
  if (setup.phase === "cancelled") return "Worktree setup cancelled";
  return setup.stages.some((stage) => stage.status === "failed") ? "Worktree ready, setup script failed" : "Worktree ready";
}

function StageIcon({ status }: { status: UiSetupStage["status"] }) {
  if (status === "running") return <span className="spinner small" aria-hidden />;
  if (status === "done") return <Check size={13} aria-hidden />;
  if (status === "failed") return <X size={13} aria-hidden />;
  if (status === "skipped") return <Minus size={13} aria-hidden />;
  return <Circle size={11} aria-hidden />;
}

/** Ticks once a second while something runs, so elapsed times stay live. */
function useNowWhile(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** Fixed height: streaming output never moves the transcript. */
function OutputTail({ lines, failed }: { lines: readonly string[]; failed: boolean }) {
  const slots = [0, 1, 2, 3].map((slot) => lines[lines.length - 4 + slot] ?? "");
  return (
    <pre className="project-scripts-setup-tail" data-failed={failed || undefined}>
      {slots.map((line, slot) => <div key={slot}>{line || "\u00a0"}</div>)}
    </pre>
  );
}

function StageRow({ stage, now }: { stage: UiSetupStage; now: number }) {
  const elapsed = stage.startedAt !== undefined && stage.status !== "pending" && stage.status !== "skipped"
    ? formatElapsed((stage.endedAt ?? now) - stage.startedAt)
    : undefined;
  const trailing = stage.status === "skipped" ? stage.detail ?? "skipped" : stage.detail;
  return (
    <div className="project-scripts-setup-stage" data-stage={stage.id} data-status={stage.status}>
      <span className="project-scripts-setup-icon"><StageIcon status={stage.status} /></span>
      <span className="project-scripts-setup-label">{stage.label}{stage.async ? <small> · in the background</small> : null}</span>
      {trailing ? <span className="project-scripts-setup-detail">{trailing}</span> : null}
      {elapsed ? <span className="project-scripts-setup-elapsed">{elapsed}</span> : null}
    </div>
  );
}

export interface SetupCardActions {
  cancel(setupId: string): Promise<void>;
  release(setupId: string): Promise<void>;
  dismiss(setupId: string): Promise<void>;
}

export function SetupCard({ setup, actions, notify }: { setup: UiWorktreeSetup; actions: SetupCardActions; notify(message: string): void }) {
  const running = setup.phase === "running";
  const now = useNowWhile(running);
  const [details, setDetails] = useState(false);
  const total = formatElapsed((setup.endedAt ?? now) - setup.startedAt);
  const waiting = running && !setup.released && setup.stages.some((stage) => stage.status === "running" && stage.id.startsWith("script:") && !stage.async);
  const act = (action: (id: string) => Promise<void>) => () => { action(setup.id).catch((error: unknown) => notify(errorMessage(error))); };
  const tone = setup.phase === "failed" ? "failed" : setup.stages.some((stage) => stage.status === "failed") ? "warning" : setup.phase;
  return (
    <section className="project-scripts-setup" aria-label="Worktree setup" data-phase={setup.phase} data-tone={tone}>
      <header>
        <span className="project-scripts-setup-headline">{headline(setup)}</span>
        <span className="project-scripts-setup-elapsed">{total}</span>
      </header>
      <div className="project-scripts-setup-stages">
        {setup.stages.map((stage) => (
          <div key={stage.id}>
            <StageRow stage={stage} now={now} />
            {stage.id.startsWith("script:") && (stage.status === "running" || stage.status === "failed")
              ? <OutputTail lines={stage.tail} failed={stage.status === "failed"} />
              : null}
          </div>
        ))}
      </div>
      {setup.phase === "failed" && setup.error ? <p className="project-scripts-setup-error">{setup.error}</p> : null}
      {details ? (
        <dl className="project-scripts-setup-details">
          {setup.branch ? <div><dt>Branch</dt><dd>{setup.branch}</dd></div> : null}
          {setup.worktree ? <div><dt>Path</dt><dd>{setup.worktree}</dd></div> : null}
          {setup.stages.filter((stage) => stage.command).map((stage) => <div key={stage.id}><dt>{stage.label}</dt><dd>{stage.command}</dd></div>)}
        </dl>
      ) : null}
      <footer>
        <button type="button" className="text-button" aria-expanded={details} onClick={() => setDetails((open) => !open)}>
          {details ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Details
        </button>
        {waiting ? <button type="button" className="text-button" onClick={act(actions.release)}><Play size={11} /> Start now</button> : null}
        {running ? <button type="button" className="text-button" onClick={act(actions.cancel)}><X size={12} /> Cancel</button> : null}
        {!running ? <button type="button" className="text-button" onClick={act(actions.dismiss)}>Dismiss</button> : null}
      </footer>
    </section>
  );
}

/** The card region: the setups of the checkout on screen. */
export function createSetupCards(store: SetupStore, host: ProjectScriptsHostClient) {
  const cardActions: SetupCardActions = {
    cancel: (setupId) => host["setup-cancel"]({ setupId }),
    release: (setupId) => host["setup-release"]({ setupId }),
    dismiss: async (setupId) => {
      store.remove(setupId);
      await host["setup-dismiss"]({ setupId });
    },
  };
  return function WorktreeSetupCards({ actions, snapshot }: RegionProps) {
    const setups = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const visible = setupsOnScreen(setups, screenOf(actions, snapshot));
    if (visible.length === 0) return null;
    return (
      <div className="project-scripts-setups">
        {visible.map((setup) => <SetupCard key={setup.id} setup={setup} actions={cardActions} notify={(message) => actions.notify(message)} />)}
      </div>
    );
  };
}

function screenOf(actions: WorkbenchActions, snapshot: RegionProps["snapshot"]): { cwd?: string; draftPending: boolean } {
  const active = actions.activeThread();
  const cwd = active?.cwd ?? snapshot?.cwd;
  return { ...(cwd ? { cwd } : {}), draftPending: active?.draftPending ?? false };
}
