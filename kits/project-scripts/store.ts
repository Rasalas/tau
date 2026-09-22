import { useSyncExternalStore } from "react";
import { HostUnavailableError, errorMessage } from "tau";
import type { ProjectScriptsHostClient, ProjectScriptsState, ScriptScope, UiScriptRun } from "./protocol.js";

export interface ProjectScriptsView {
  /** The project file of the checkout on screen, once the host answered. */
  state?: ProjectScriptsState;
  /** Every run the host holds, newest first. */
  runs: UiScriptRun[];
  /** Why the host could not answer; the bar says it instead of the scripts. */
  error?: string;
}

const scopeKey = (scope: ScriptScope) => `${scope.sessionId ?? ""}\u0000${scope.workspaceId ?? ""}`;

/**
 * What the bar and the commands read: the scripts of the checkout the
 * workbench shows, and the runs the host pushes. One per activation.
 */
export class ProjectScriptsStore {
  private view: ProjectScriptsView = { runs: [] };
  private scope: ScriptScope | undefined;
  private readonly listeners = new Set<() => void>();
  private request = 0;

  constructor(private readonly host: ProjectScriptsHostClient) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): ProjectScriptsView => this.view;

  currentScope(): ScriptScope | undefined {
    return this.scope;
  }

  /** Points the store at another checkout; the same one again is a no-op. */
  follow(scope: ScriptScope): void {
    if (this.scope && scopeKey(this.scope) === scopeKey(scope)) return;
    this.scope = scope;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const scope = this.scope;
    if (!scope) return;
    const request = ++this.request;
    try {
      const state = await this.host.list(scope);
      if (request !== this.request) return;
      this.set({ ...this.view, state, error: undefined });
    } catch (error) {
      if (request !== this.request) return;
      this.set({ runs: this.view.runs, ...(error instanceof HostUnavailableError ? {} : { error: errorMessage(error) }) });
    }
  }

  async loadRuns(): Promise<void> {
    try {
      const runs = await this.host.runs();
      this.set({ ...this.view, runs: [...runs].sort((left, right) => right.startedAt - left.startedAt) });
    } catch {
      // No host yet; the pushes fill the list.
    }
  }

  /** The file of the checkout on screen changed on disk. */
  scriptsChanged(directory: string): void {
    if (this.view.state?.directory === directory) void this.refresh();
  }

  /** Answers the record this one replaced, so a caller can see what changed. */
  applyRun(run: UiScriptRun): UiScriptRun | undefined {
    const previous = this.view.runs.find((candidate) => candidate.id === run.id);
    const others = this.view.runs.filter((candidate) => candidate.id !== run.id);
    this.set({ ...this.view, runs: [run, ...others].sort((left, right) => right.startedAt - left.startedAt) });
    return previous;
  }

  removeRun(id: string): void {
    if (!this.view.runs.some((run) => run.id === id)) return;
    this.set({ ...this.view, runs: this.view.runs.filter((run) => run.id !== id) });
  }

  private set(view: ProjectScriptsView): void {
    this.view = view;
    for (const listener of [...this.listeners]) listener();
  }
}

export function useProjectScripts(store: ProjectScriptsStore): ProjectScriptsView {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
