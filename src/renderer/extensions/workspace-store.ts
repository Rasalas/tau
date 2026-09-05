import { useSyncExternalStore } from "react";
import type { FileNode, UiEditor, UiFileDiff, UiWorkspaceChanges, WorkspaceInfo } from "../../shared/workspace-kit-types";
import type { HostActionResult } from "../../shared/host-protocol";
import type { WorkbenchActions } from "../extension-system";
import { errorMessage } from "../error-message";
import type { PreferencesStore } from "../preferences";
import { changesSinceTurn, changesTouchedByTools, readCachedTurnActivity } from "../turn-activity";
import type { UiToolRun } from "../../shared/contracts";
import { getHostClient } from "../host-client-context";
import { hostHasLocalFiles } from "../use-host-capabilities";
import { getClientStorage } from "../client-storage";
import { STORAGE_KEYS } from "../storage-keys";
import { useWorkspaceStore } from "../renderer-services-context";
import { workspaceKit } from "./workspace-kit-client";

export const WORKSPACE_KIT_ID = "tau.workspace";
export const NO_CHANGES: UiWorkspaceChanges = { files: [], added: 0, removed: 0 };
const BASELINE_CACHE_KEY = STORAGE_KEYS.workspaceTurnBaseline;

export interface WorkspaceKitState {
  /** The project the store follows: the draft's project while a new thread is pending, else the thread's. */
  cwd?: string;
  /** How the host names that project; what every command sends back. */
  workspaceId?: string;
  draftPending: boolean;
  changes: UiWorkspaceChanges;
  workspace?: WorkspaceInfo;
  workspaceBusy: boolean;
  editors: UiEditor[];
  fileTree: FileNode[];
  committing: boolean;
  pushPrimary: boolean;
  commitFocusToken: number;
  /** Changes at the start of the running turn, so the dock can show what the turn touched. */
  turnBaseline?: UiWorkspaceChanges;
  /** The turn ended without a checkpoint replacing the dock. */
  turnSettled: boolean;
  review?: { path?: string; primaryPush: boolean };
  /** An extension offers to name new worktrees. */
  canNameWorktrees: boolean;
}

export interface WorktreeNameRequest {
  /** What the user typed into the worktree search, if anything. */
  hint: string;
  /** The unsent composer text describing the task. */
  description: string;
  /** Branch names already in the repository. */
  taken: string[];
  actions: WorkbenchActions;
}

export type WorktreeNamer = (request: WorktreeNameRequest) => Promise<string>;
export type CommitMessageSuggester = (request: {
  changes: UiWorkspaceChanges;
  diffs: readonly UiFileDiff[];
  actions: WorkbenchActions;
}) => Promise<string>;

const INITIAL: WorkspaceKitState = {
  draftPending: false,
  changes: NO_CHANGES,
  workspaceBusy: false,
  editors: [],
  fileTree: [],
  committing: false,
  pushPrimary: false,
  commitFocusToken: 0,
  turnSettled: false,
  canNameWorktrees: false,
};

function readBaseline(sessionId: string): UiWorkspaceChanges | undefined {
  try {
    const storage = getClientStorage();
    if (!storage) return undefined;
    const all = JSON.parse(storage.get(BASELINE_CACHE_KEY) ?? "{}") as Record<string, UiWorkspaceChanges>;
    // Baselines written before the kit owned them live in core's turn-activity cache.
    return all[sessionId] ?? readCachedTurnActivity(storage, sessionId)?.baseline;
  } catch { return undefined; }
}

function writeBaseline(sessionId: string, baseline: UiWorkspaceChanges | undefined): void {
  try {
    const storage = getClientStorage();
    if (!storage) return;
    const all = JSON.parse(storage.get(BASELINE_CACHE_KEY) ?? "{}") as Record<string, UiWorkspaceChanges>;
    if (baseline) all[sessionId] = baseline; else delete all[sessionId];
    const entries = Object.entries(all).slice(-12);
    storage.set(BASELINE_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* cache only */ }
}

/**
 * Workspace Kit's own state: Git status, workspace info, editors, the file
 * index, the running turn's baseline and the review request. Core never reads
 * it; the kit's regions, panels and controls do.
 */
export class WorkspaceStore {
  private state: WorkspaceKitState = INITIAL;
  private listeners = new Set<() => void>();
  private actions?: WorkbenchActions;
  private changesRequest = 0;
  private workspaceRequest = 0;
  private sessionId?: string;
  private namer?: WorktreeNamer;
  private commitMessageSuggester?: CommitMessageSuggester;

  constructor(private readonly preferences: PreferencesStore) {}

  getSnapshot = (): WorkspaceKitState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  bind(actions: WorkbenchActions): void { this.actions = actions; }

  /** How the followed project is named on the host: its id, or its path for a host that gave none. */
  workspace(): string | undefined {
    return this.state.workspaceId ?? this.state.cwd;
  }

  /** Public for the kit's tests; the kit's own code goes through the actions below. */
  update(patch: Partial<WorkspaceKitState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private notify(message: string): void { this.actions?.notify(message); }

  /** Blocks actions that would otherwise run against the previous thread's workspace. */
  private allowed(what: string): boolean {
    if (!this.state.draftPending) return true;
    this.notify(`${what} is unavailable until this draft becomes a thread.`);
    return false;
  }

  private hostAvailable(what: string): boolean {
    if (getHostClient()) return true;
    this.notify(`${what} requires the Electron host`);
    return false;
  }

  /** Follows the workbench: called whenever the thread, its project, or the draft state changes. */
  follow(next: { cwd?: string; workspaceId?: string; sessionId?: string; draftPending: boolean }): void {
    const projectChanged = next.cwd !== this.state.cwd;
    const threadChanged = next.sessionId !== this.sessionId;
    this.sessionId = next.sessionId;
    this.update({
      cwd: next.cwd,
      workspaceId: next.workspaceId,
      draftPending: next.draftPending,
      ...(projectChanged ? { changes: NO_CHANGES, fileTree: [], workspace: undefined } : {}),
      ...(threadChanged ? { turnBaseline: next.sessionId ? readBaseline(next.sessionId) : undefined, turnSettled: false } : {}),
    });
    if (next.cwd && (projectChanged || threadChanged)) {
      void this.refreshChanges();
      void this.refreshWorkspace();
    }
  }

  /** Editors run on the host's machine; a client elsewhere is offered none. */
  async loadEditors(): Promise<void> {
    if (!getHostClient()) return;
    if (!hostHasLocalFiles(getHostClient())) { this.update({ editors: [] }); return; }
    try { this.update({ editors: await workspaceKit.listEditors() }); } catch { this.update({ editors: [] }); }
  }

  activeEditor(): UiEditor | undefined {
    const preferred = this.preferences.value(WORKSPACE_KIT_ID, "editor");
    return this.state.editors.find((editor) => editor.id === preferred) ?? this.state.editors[0];
  }

  chooseEditor(id: string): void { this.preferences.setValue(WORKSPACE_KIT_ID, "editor", id); }

  async refreshChanges(): Promise<void> {
    if (!getHostClient()) return;
    const request = ++this.changesRequest;
    const cwd = this.state.cwd;
    if (this.state.draftPending) { this.update({ changes: NO_CHANGES }); return; }
    try {
      const next = await workspaceKit.getChanges();
      if (request === this.changesRequest && cwd === this.state.cwd) this.update({ changes: next });
    } catch (error) {
      if (request === this.changesRequest) this.notify(errorMessage(error));
    }
  }

  async refreshWorkspace(): Promise<void> {
    if (!getHostClient()) return;
    const request = ++this.workspaceRequest;
    const cwd = this.state.cwd;
    this.update({ workspaceBusy: true });
    try {
      const next = this.state.draftPending && cwd ? await workspaceKit.getWorkspaceInfo(this.workspace()) : await workspaceKit.getWorkspaceInfo();
      if (request === this.workspaceRequest && cwd === this.state.cwd) this.update({ workspace: next });
    } catch (error) {
      if (request === this.workspaceRequest) this.notify(errorMessage(error));
    } finally {
      if (request === this.workspaceRequest) this.update({ workspaceBusy: false });
    }
  }

  async refreshFiles(): Promise<void> {
    if (!getHostClient()) return;
    try { this.update({ fileTree: (await workspaceKit.getFileTree()) ?? [] }); }
    catch (error) { this.notify(errorMessage(error)); }
  }

  async loadFiles(path: string): Promise<FileNode[]> {
    const children = getHostClient() ? ((await workspaceKit.getFileTree(path)) ?? []) : [];
    const attach = (nodes: FileNode[]): FileNode[] => nodes.map((node) => node.path === path
      ? { ...node, children }
      : node.children ? { ...node, children: attach(node.children) } : node);
    this.update({ fileTree: attach(this.state.fileTree) });
    return children;
  }

  /** Turn lifecycle, fed by workbench events. */
  turnStarted(sessionId: string): void {
    if (sessionId !== this.sessionId) return;
    const baseline = this.state.changes;
    writeBaseline(sessionId, baseline);
    this.update({ turnBaseline: baseline, turnSettled: false });
  }

  turnSettled(sessionId: string): void {
    if (sessionId !== this.sessionId) return;
    this.update({ turnSettled: true });
    void this.refreshChanges();
  }

  checkpointRecorded(sessionId: string): void {
    if (sessionId !== this.sessionId) return;
    this.update({ turnSettled: false });
  }

  toolFinished(tool: UiToolRun): void {
    const command = typeof tool.args.command === "string" ? tool.args.command : "";
    if (tool.name === "edit" || tool.name === "write" || /\bgit\b/u.test(command)) void this.refreshChanges();
  }

  turnChanges(tools: readonly UiToolRun[]): UiWorkspaceChanges {
    const { turnBaseline, changes } = this.state;
    return turnBaseline ? changesSinceTurn(turnBaseline, changes) : changesTouchedByTools(tools, changes);
  }

  openDiff(relativePath: string): void {
    if (this.state.cwd) this.actions?.openFile(`${this.state.cwd}/${relativePath}`, { view: "diff" });
  }

  openReview(path?: string, pushPrimary = Boolean(this.state.workspace?.upstream)): void {
    void this.refreshChanges();
    this.update({ pushPrimary, review: { path: path ?? this.state.changes.files[0]?.path, primaryPush: pushPrimary } });
    this.actions?.openOverlay("review.workspace");
  }

  selectReviewPath(path: string): void {
    if (this.state.review) this.update({ review: { ...this.state.review, path } });
  }

  closeReview(): void {
    this.update({ review: undefined });
    this.actions?.closeOverlay();
  }

  focusCommit(): void { this.update({ commitFocusToken: this.state.commitFocusToken + 1 }); }

  private async mutate(what: string, run: () => Promise<UiWorkspaceChanges>): Promise<void> {
    if (!this.allowed(what) || !this.hostAvailable(what)) return;
    try { this.update({ changes: await run() }); }
    catch (error) { this.notify(errorMessage(error)); }
  }

  stageFile(path: string): Promise<void> { return this.mutate("Staging changes", () => workspaceKit.stageFile(path)); }
  unstageFile(path: string): Promise<void> { return this.mutate("Unstaging changes", () => workspaceKit.unstageFile(path)); }
  stageAll(): Promise<void> { return this.mutate("Staging changes", () => workspaceKit.stageAll()); }
  revertFile(path: string): Promise<void> { return this.mutate("Reverting changes", () => workspaceKit.revertFile(path)); }

  async commit(message: string, push: boolean): Promise<void> {
    if (!this.allowed("Committing") || !this.hostAvailable("Committing")) return;
    this.update({ committing: true });
    try {
      const result = await workspaceKit.commit(message, push);
      this.update({ changes: result.changes });
      this.notify(result.detail);
      void this.refreshWorkspace();
    } catch (error) {
      this.notify(errorMessage(error));
    } finally {
      this.update({ committing: false });
    }
  }

  async push(): Promise<void> {
    if (!this.allowed("Pushing") || !this.hostAvailable("Pushing")) return;
    this.update({ committing: true });
    try {
      const result = await workspaceKit.push();
      this.notify(result.detail);
      await Promise.all([this.refreshChanges(), this.refreshWorkspace()]);
    } catch (error) {
      this.notify(errorMessage(error));
    } finally {
      this.update({ committing: false });
    }
  }

  async openInEditor(relPath?: string, editorOverride?: string): Promise<void> {
    if (!this.allowed("Opening an editor")) return;
    if (!hostHasLocalFiles(getHostClient())) { this.notify("This host's files are not on this machine."); return; }
    const editorId = editorOverride ?? this.activeEditor()?.id;
    if (!editorId) { this.notify("No supported editor found on PATH"); return; }
    if (!this.hostAvailable("Opening an editor")) return;
    try { await workspaceKit.openInEditor(editorId, relPath); }
    catch (error) { this.notify(errorMessage(error)); }
  }

  async runShellAction(command: string, includeInContext: boolean, name: string): Promise<void> {
    if (!this.allowed("Project actions") || !this.hostAvailable("Project actions") || !this.actions) return;
    try {
      this.notify(`Running ${name}…`);
      const result = await this.actions.runShellAction(command, includeInContext);
      const tail = result.output.trim().split("\n").at(-1);
      this.notify(result.exitCode === 0 ? `${name} finished${tail ? ` · ${tail}` : ""}` : `${name} failed${tail ? ` · ${tail}` : ""}`);
      await Promise.all([this.refreshChanges(), this.refreshWorkspace()]);
    } catch (error) {
      this.notify(errorMessage(error));
    }
  }

  /** Worktree and ref switches change the workspace; the host result carries the new thread. */
  private async workspaceAction(action: () => Promise<HostActionResult>): Promise<boolean> {
    if (!this.allowed("Worktree actions") || !this.hostAvailable("Worktrees") || !this.actions) return false;
    // A prompt sent now would land in the thread being replaced.
    const release = this.actions.holdComposer();
    this.update({ workspaceBusy: true });
    try {
      this.actions.applyHostResult(await action());
      return true;
    } catch (error) {
      this.notify(errorMessage(error));
      return false;
    } finally {
      this.update({ workspaceBusy: false });
      release();
    }
  }

  /**
   * Adds a worktree beside the followed project and moves there with the text
   * typed so far. Works for a pending draft too: the draft's project is named
   * explicitly instead of relying on the host's thread.
   */
  async createWorktree(branch: string, baseRef?: string): Promise<boolean> {
    if (!this.hostAvailable("Worktrees") || !this.actions) return false;
    // A prompt sent now would land in the thread being replaced.
    const release = this.actions.holdComposer();
    this.update({ workspaceBusy: true });
    try {
      const created = await workspaceKit.createWorktree(branch, baseRef, this.workspace());
      return await this.actions.openWorkspace(created.workspaceId, { inheritDraft: true });
    } catch (error) {
      this.notify(errorMessage(error));
      return false;
    } finally {
      this.update({ workspaceBusy: false });
      release();
    }
  }

  /** Another extension may offer to name a worktree; the picker shows the offer only while one is registered. */
  registerWorktreeNamer(namer: WorktreeNamer): () => void {
    this.namer = namer;
    this.update({ canNameWorktrees: true });
    return () => {
      if (this.namer !== namer) return;
      this.namer = undefined;
      this.update({ canNameWorktrees: false });
    };
  }

  /** A branch name for the task at hand, from the draft text and whatever the user typed into the picker. */
  async suggestWorktreeName(hint: string): Promise<string | undefined> {
    if (!this.namer || !this.actions) return undefined;
    try {
      const taken = this.state.workspace?.refs.map((ref) => ref.name) ?? [];
      return await this.namer({ hint, description: this.actions.composerDraft(), taken, actions: this.actions });
    } catch (error) {
      this.notify(errorMessage(error));
      return undefined;
    }
  }

  registerCommitMessageSuggester(suggester: CommitMessageSuggester): () => void {
    this.commitMessageSuggester = suggester;
    return () => { if (this.commitMessageSuggester === suggester) this.commitMessageSuggester = undefined; };
  }

  async suggestCommitMessage(changes: UiWorkspaceChanges, diffs: readonly UiFileDiff[]): Promise<string | undefined> {
    if (!this.commitMessageSuggester || !this.actions) return undefined;
    try { return await this.commitMessageSuggester({ changes, diffs, actions: this.actions }); }
    catch (error) { this.notify(errorMessage(error)); return undefined; }
  }

  switchRef(ref: string): Promise<boolean> { return this.workspaceAction(() => workspaceKit.switchRef(ref)); }
  async openWorktree(path: string): Promise<boolean> {
    if (path === this.state.cwd) return true;
    return this.actions ? this.actions.openWorkspace(path) : false;
  }
}

/** The kit's components read the active store through this hook. */
export function useWorkspaceKit(): WorkspaceKitState {
  const store = useWorkspaceStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
