import {
  changesSinceTurn,
  changesTouchedByTools,
  errorMessage,
  getClientStorage,
  hostAvailable,
  hostHasLocalFiles,
  hostIsReadOnly,
  readCachedTurnActivity,
  type FileNode,
  type HostActionResult,
  type PreferencesStore,
  type UiProject,
  type UiSession,
  type UiEditor,
  type UiTerminal,
  type UiFileDiff,
  type UiToolRun,
  type UiWorkspaceChanges,
  type WorkbenchActions,
} from "tau";
import type { ComponentType } from "react";
import { CloneToasts } from "./clone-toasts.js";
import {
  AUTO_PULL_OPTION,
  isWorktreeSubmodules,
  WORKSPACE_HOST_EXTENSION_ID,
  WORKSPACE_REVIEW_OVERLAY,
  type ChangesSectionProps,
  type CommitMessageSuggester,
  type EditorPosition,
  type WorkspaceFileEditor,
  type ProjectDefaults,
  type WorkspaceHostClient,
  type WorkspaceKitState,
  type WorkspaceMode,
  type ThreadRailOrganizer,
  type ThreadRowAccessoryProps,
  type RailThreadSource,
  type ThreadWorktreeRequest,
  type TurnStat,
  type WorkspaceStoreApi,
  type WorktreeNamer,
  type WorktreeSubmodules,
} from "./protocol.js";
import { recordTurnStat } from "./turn-stats.js";

export const WORKSPACE_KIT_ID = WORKSPACE_HOST_EXTENSION_ID;
export const NO_CHANGES: UiWorkspaceChanges = { files: [], added: 0, removed: 0 };
/** The kit's own key; core stopped listing it when the kit moved out. */
const BASELINE_CACHE_KEY = "tau.workspace.turn-baseline.v1";

const INITIAL: WorkspaceKitState = {
  draftPending: false,
  changes: NO_CHANGES,
  workspaceBusy: false,
  editors: [],
  terminals: [],
  fileTree: [],
  committing: false,
  pushPrimary: false,
  commitFocusToken: 0,
  turnSettled: false,
  canNameWorktrees: false,
  workspaceMode: "current",
  preparingWorktree: false,
  changesSections: [],
  threadRowAccessories: [],
  railSections: [],
  railThreadSources: [],
  defaultBranches: {},
  turnStats: {},
};

/** The user's global answer for where a new thread runs. */
export const NEW_THREAD_WORKSPACE_KEY = "new-thread-workspace";
/** Whether a new worktree starts from the freshly fetched remote; on by default. */
export const START_FROM_ORIGIN_OPTION = "start-from-origin";
/** How a new worktree fills its submodules; unset lets the checkout's project file decide. */
export const WORKTREE_SUBMODULES_KEY = "worktree-submodules";
/** Where new projects start: the folder browser and the clone's destination. */
export const PROJECT_BASE_DIRECTORY_KEY = "project-base-directory";
export { AUTO_PULL_OPTION };

/** A project's own override of the global default, kept per checkout. */
export function projectWorkspaceModeKey(root: string): string {
  return `workspace-mode:${root}`;
}

function asMode(value: string | undefined): WorkspaceMode | undefined {
  return value === "current" || value === "worktree" ? value : undefined;
}

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
export class WorkspaceStore implements WorkspaceStoreApi {
  private state: WorkspaceKitState = INITIAL;
  private listeners = new Set<() => void>();
  private actions?: WorkbenchActions;
  /** Kits that draw the review overlay. */
  private reviewViews = 0;
  private changesRequest = 0;
  private workspaceRequest = 0;
  private sessionId?: string;
  private namer?: WorktreeNamer;
  private defaults?: ProjectDefaults;
  private commitMessageSuggester?: CommitMessageSuggester;
  private fileEditor?: WorkspaceFileEditor;

  /** Clones in flight and just finished, as toasts. */
  readonly clones: CloneToasts;

  constructor(
    private readonly preferences: PreferencesStore,
    /** The kit's own host entry, reached through the extension channel. */
    readonly host: WorkspaceHostClient,
  ) {
    this.clones = new CloneToasts(host);
  }

  getSnapshot = (): WorkspaceKitState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  bind(actions: WorkbenchActions): void {
    this.actions = actions;
    this.clones.bind(actions);
  }

  /** Where the folder browser opens and a clone lands by default; unset means the home folder and a picker. */
  projectBaseDirectory(): string | undefined {
    return this.preferences.value(WORKSPACE_KIT_ID, PROJECT_BASE_DIRECTORY_KEY)?.trim() || undefined;
  }

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

  private readonly defaultBranchRequests = new Set<string>();

  /** Asks the host once per project; until it answers, or when it cannot, the rail guesses. */
  loadDefaultBranch(workspace: string): void {
    if (this.defaultBranchRequests.has(workspace)) return;
    this.defaultBranchRequests.add(workspace);
    void this.host.getDefaultBranch(workspace).then(
      (branch) => this.update({ defaultBranches: { ...this.state.defaultBranches, [workspace]: branch } }),
      () => undefined,
    );
  }

  /** Blocks actions that would otherwise run against the previous thread's workspace. */
  private allowed(what: string): boolean {
    if (!this.state.draftPending) return true;
    this.notify(`${what} is unavailable until this draft becomes a thread.`);
    return false;
  }

  private requireHost(what: string): boolean {
    if (hostAvailable()) return true;
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
    if (next.cwd && projectChanged) {
      void this.autoPullDefaultBranch();
      this.defaults = undefined;
      this.update({ workspaceMode: this.defaultWorkspaceMode(), worktreeBase: undefined });
      void this.loadProjectDefaults();
    }
  }

  /**
   * Where a new thread of this project runs when nobody chose: the project's
   * own answer beats the checked-in one, and both beat the global default.
   */
  private defaultWorkspaceMode(): WorkspaceMode {
    const root = this.state.cwd;
    const own = root ? asMode(this.preferences.value(WORKSPACE_KIT_ID, projectWorkspaceModeKey(root))) : undefined;
    return own ?? this.defaults?.workspaceMode ?? asMode(this.preferences.value(WORKSPACE_KIT_ID, NEW_THREAD_WORKSPACE_KEY)) ?? "current";
  }

  /** `.tau/project.json`, read once per project. */
  private async loadProjectDefaults(): Promise<void> {
    if (!hostAvailable()) return;
    const cwd = this.state.cwd;
    try {
      const defaults = await this.host.getProjectDefaults(this.workspace());
      if (cwd !== this.state.cwd) return;
      this.defaults = defaults;
      this.update({ workspaceMode: this.defaultWorkspaceMode() });
    } catch { /* a project without the file simply has no answer */ }
  }

  workspaceMode(): WorkspaceMode {
    return this.state.draftPending ? this.state.workspaceMode : "current";
  }

  /** The choice is this draft's, and is remembered as the project's default. */
  setWorkspaceMode(mode: WorkspaceMode): void {
    const root = this.state.cwd;
    if (root) this.preferences.setValue(WORKSPACE_KIT_ID, projectWorkspaceModeKey(root), mode);
    this.update({ workspaceMode: mode });
  }

  /** Whether a new worktree starts from the freshly fetched remote commit. */
  startFromOrigin(): boolean {
    return this.preferences.optionValue(WORKSPACE_KIT_ID, START_FROM_ORIGIN_OPTION, true);
  }

  /** What a new worktree is made with: where it starts and how far its submodules go. */
  private worktreeOptions(): { startFromOrigin: boolean; submodules?: WorktreeSubmodules } {
    const submodules = this.preferences.value(WORKSPACE_KIT_ID, WORKTREE_SUBMODULES_KEY);
    return { startFromOrigin: this.startFromOrigin(), ...(isWorktreeSubmodules(submodules) ? { submodules } : {}) };
  }

  /**
   * Asks the host to fast-forward the project's default branch, when the user
   * turned that on. Quiet: a checkout that cannot be fast-forwarded is simply
   * left alone, and the next focus or tick asks again.
   */
  async autoPullDefaultBranch(): Promise<void> {
    // A Read-only device's pull would be refused; the owner's own clients pull.
    if (!this.preferences.optionValue(WORKSPACE_KIT_ID, AUTO_PULL_OPTION, false) || !hostAvailable() || hostIsReadOnly()) return;
    const workspace = this.workspace();
    if (!workspace) return;
    try {
      const outcomes = await this.host.autoPull(workspace);
      if (outcomes.some((outcome) => outcome.status === "pulled") && workspace === this.workspace()) await this.refresh();
    } catch { /* the next focus or tick tries again */ }
  }

  /** Where a new worktree would start; read when the picker opens, never on every render. */
  async loadWorktreeBase(): Promise<void> {
    if (!hostAvailable() || !this.state.workspace?.isRepo) return;
    const cwd = this.state.cwd;
    try {
      const base = await this.host.getWorktreeBase(this.workspace(), { startFromOrigin: this.startFromOrigin() });
      if (cwd === this.state.cwd) this.update({ worktreeBase: base });
    } catch (error) {
      if (cwd === this.state.cwd) this.notify(errorMessage(error));
    }
  }

  /** Editors run on the host's machine; a client elsewhere is offered none. */
  async loadEditors(): Promise<void> {
    if (!hostAvailable()) return;
    if (!hostHasLocalFiles()) { this.update({ editors: [] }); return; }
    try { this.update({ editors: await this.host.listEditors() }); } catch { this.update({ editors: [] }); }
  }

  activeEditor(): UiEditor | undefined {
    const preferred = this.preferences.value(WORKSPACE_KIT_ID, "editor");
    return this.state.editors.find((editor) => editor.id === preferred) ?? this.state.editors[0];
  }

  chooseEditor(id: string): void { this.preferences.setValue(WORKSPACE_KIT_ID, "editor", id); }

  /** Terminals run on the host's machine; a client elsewhere is offered none. */
  async loadTerminals(): Promise<void> {
    if (!hostAvailable()) return;
    if (!hostHasLocalFiles()) { this.update({ terminals: [] }); return; }
    try { this.update({ terminals: await this.host.listTerminals() }); } catch { this.update({ terminals: [] }); }
  }

  activeTerminal(): UiTerminal | undefined {
    const preferred = this.preferences.value(WORKSPACE_KIT_ID, "terminal");
    return this.state.terminals.find((terminal) => terminal.id === preferred) ?? this.state.terminals[0];
  }

  chooseTerminal(id: string): void { this.preferences.setValue(WORKSPACE_KIT_ID, "terminal", id); }

  async openTerminal(terminalOverride?: string): Promise<void> {
    if (!hostHasLocalFiles()) { this.notify("This host's files are not on this machine."); return; }
    const terminalId = terminalOverride ?? this.activeTerminal()?.id;
    if (!this.requireHost("Opening a terminal")) return;
    try { await this.host.openTerminal(terminalId, this.workspace()); }
    catch (error) { this.notify(errorMessage(error)); }
  }

  async refreshChanges(): Promise<void> {
    if (!hostAvailable()) return;
    const request = ++this.changesRequest;
    const cwd = this.state.cwd;
    if (this.state.draftPending) { this.update({ changes: NO_CHANGES }); return; }
    try {
      const next = await this.host.getChanges();
      if (request === this.changesRequest && cwd === this.state.cwd) this.update({ changes: next });
    } catch (error) {
      if (request === this.changesRequest) this.notify(errorMessage(error));
    }
  }

  async refreshWorkspace(): Promise<void> {
    if (!hostAvailable()) return;
    const request = ++this.workspaceRequest;
    const cwd = this.state.cwd;
    this.update({ workspaceBusy: true });
    try {
      const next = this.state.draftPending && cwd ? await this.host.getWorkspaceInfo(this.workspace()) : await this.host.getWorkspaceInfo();
      if (request === this.workspaceRequest && cwd === this.state.cwd) this.update({ workspace: next });
    } catch (error) {
      if (request === this.workspaceRequest) this.notify(errorMessage(error));
    } finally {
      if (request === this.workspaceRequest) this.update({ workspaceBusy: false });
    }
  }

  async refreshFiles(): Promise<void> {
    if (!hostAvailable()) return;
    try { this.update({ fileTree: (await this.host.getFileTree()) ?? [] }); }
    catch (error) { this.notify(errorMessage(error)); }
  }

  async loadFiles(path: string): Promise<FileNode[]> {
    const children = hostAvailable() ? ((await this.host.getFileTree(path)) ?? []) : [];
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
    // Another thread's tools reach only the clients showing it; the end of its turn reaches all.
    if (sessionId === this.sessionId) this.update({ turnSettled: true });
    void this.refreshChanges();
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
    // Review Kit fills this overlay (it imports the id from here); without that kit the request is simply unanswered.
    this.actions?.openOverlay(WORKSPACE_REVIEW_OVERLAY);
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
    if (!this.allowed(what) || !this.requireHost(what)) return;
    try { this.update({ changes: await run() }); }
    catch (error) { this.notify(errorMessage(error)); }
  }

  stageFile(path: string): Promise<void> { return this.mutate("Staging changes", () => this.host.stageFile(path)); }
  unstageFile(path: string): Promise<void> { return this.mutate("Unstaging changes", () => this.host.unstageFile(path)); }
  stageAll(): Promise<void> { return this.mutate("Staging changes", () => this.host.stageAll()); }
  revertFile(path: string): Promise<void> { return this.mutate("Reverting changes", () => this.host.revertFile(path)); }

  async commit(message: string, push: boolean): Promise<boolean> {
    if (!this.allowed("Committing") || !this.requireHost("Committing")) return false;
    this.update({ committing: true });
    try {
      const result = await this.host.commit(message, push);
      this.update({ changes: result.changes });
      this.notify(result.detail);
      void this.refreshWorkspace();
      return true;
    } catch (error) {
      this.notify(errorMessage(error));
      return false;
    } finally {
      this.update({ committing: false });
    }
  }

  async pull(): Promise<void> {
    if (!this.allowed("Pulling") || !this.requireHost("Pulling")) return;
    this.update({ committing: true });
    try {
      const result = await this.host.pull();
      this.notify(result.detail);
      await Promise.all([this.refreshChanges(), this.refreshWorkspace()]);
    } catch (error) {
      this.notify(errorMessage(error));
    } finally {
      this.update({ committing: false });
    }
  }

  async push(): Promise<void> {
    if (!this.allowed("Pushing") || !this.requireHost("Pushing")) return;
    this.update({ committing: true });
    try {
      const result = await this.host.push();
      this.notify(result.detail);
      await Promise.all([this.refreshChanges(), this.refreshWorkspace()]);
    } catch (error) {
      this.notify(errorMessage(error));
    } finally {
      this.update({ committing: false });
    }
  }

  async openInEditor(relPath?: string, editorOverride?: string, position?: EditorPosition): Promise<void> {
    if (!hostHasLocalFiles()) { this.notify("This host's files are not on this machine."); return; }
    const editorId = editorOverride ?? this.activeEditor()?.id;
    if (!editorId) { this.notify("No supported editor found on PATH"); return; }
    if (!this.requireHost("Opening an editor")) return;
    try { await this.host.openInEditor(editorId, relPath, this.workspace(), position); }
    catch (error) { this.notify(errorMessage(error)); }
  }

  async runShellAction(command: string, includeInContext: boolean, name: string): Promise<void> {
    if (!this.allowed("Project actions") || !this.requireHost("Project actions") || !this.actions) return;
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
    if (!this.allowed("Worktree actions") || !this.requireHost("Worktrees") || !this.actions) return false;
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
    if (!this.requireHost("Worktrees") || !this.actions) return false;
    // A prompt sent now would land in the thread being replaced.
    const release = this.actions.holdComposer();
    this.update({ workspaceBusy: true });
    try {
      const created = await this.host.createWorktree(branch, { ...(baseRef ? { baseRef } : {}), ...this.worktreeOptions() }, this.workspace());
      return await this.actions.openWorkspace(created.workspaceId, { inheritDraft: true });
    } catch (error) {
      this.notify(errorMessage(error));
      return false;
    } finally {
      this.update({ workspaceBusy: false });
      release();
    }
  }

  /**
   * The worktree a new thread runs in, created while its first prompt waits.
   * Anything that goes wrong leaves the thread in the checkout it was started
   * from: a prompt is never lost to a worktree that could not be made.
   */
  async prepareThreadWorktree(event: ThreadWorktreeRequest): Promise<{ workspace?: { workspaceId: string; displayPath: string } }> {
    if ((!event.force && this.workspaceMode() !== "worktree") || !this.state.workspace?.isRepo || !hostAvailable()) return {};
    this.update({ preparingWorktree: true });
    try {
      event.preparing("Setting up worktree…");
      const named = await this.threadBranchName(event.prompt);
      const branch = event.branchSuffix ? `${named}-${event.branchSuffix}` : named;
      const created = await this.host.createWorktree(branch, this.worktreeOptions(), this.workspace());
      return { workspace: { workspaceId: created.workspaceId, displayPath: created.displayPath } };
    } catch (error) {
      this.notify(`The worktree could not be created; this thread runs in the checkout. ${errorMessage(error)}`);
      return {};
    } finally {
      this.update({ preparingWorktree: false });
    }
  }

  /**
   * A branch for the thread that is starting. The naming extension reads the
   * whole first prompt, which T3 Code cannot: it names the branch afterwards,
   * from the first message it already sent. Without that extension the branch
   * is `tau/<8 hex>`, which the user can rename later.
   */
  private async threadBranchName(prompt: string): Promise<string> {
    const taken = this.state.workspace?.refs.map((ref) => ref.name) ?? [];
    if (this.namer && this.actions) {
      try {
        const named = await this.namer({ hint: "", description: prompt, taken, actions: this.actions });
        if (named) return named;
      } catch { /* the fallback name is always available */ }
    }
    for (;;) {
      const candidate = `tau/${Math.random().toString(16).slice(2, 10)}`;
      if (!taken.includes(candidate)) return candidate;
    }
  }

  /** Removes a worktree the user no longer wants, after they saw what it holds. */
  async removeWorktree(path: string, branch?: string): Promise<boolean> {
    if (!this.requireHost("Worktrees")) return false;
    this.update({ workspaceBusy: true });
    try {
      await this.host.removeWorktree(path, branch, this.workspace());
      await this.refreshWorkspace();
      this.notify(`Removed ${path}.`);
      return true;
    } catch (error) {
      this.notify(errorMessage(error));
      return false;
    } finally {
      this.update({ workspaceBusy: false });
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

  async refresh(): Promise<void> {
    await Promise.all([this.refreshChanges(), this.refreshWorkspace()]);
  }

  registerChangesSection(section: ComponentType<ChangesSectionProps>): () => void {
    this.update({ changesSections: [...this.state.changesSections, section] });
    return () => this.update({ changesSections: this.state.changesSections.filter((entry) => entry !== section) });
  }

  registerReviewView(): () => void {
    this.reviewViews += 1;
    let registered = true;
    return () => { if (registered) { registered = false; this.reviewViews -= 1; } };
  }

  /** The review in place of the Changes panel, while a kit draws it; false leaves the panel to open. */
  openChangesView(): boolean {
    if (this.reviewViews === 0) return false;
    this.openReview();
    return true;
  }

  registerThreadRowAccessory(accessory: ComponentType<ThreadRowAccessoryProps>): () => void {
    this.update({ threadRowAccessories: [...this.state.threadRowAccessories, accessory] });
    return () => this.update({ threadRowAccessories: this.state.threadRowAccessories.filter((entry) => entry !== accessory) });
  }

  registerRailSection(section: ComponentType<{ actions: WorkbenchActions }>): () => void {
    this.update({ railSections: [...this.state.railSections, section] });
    return () => this.update({ railSections: this.state.railSections.filter((entry) => entry !== section) });
  }

  registerRailThreads(source: RailThreadSource): () => void {
    this.update({ railThreadSources: [...this.state.railThreadSources, source] });
    return () => this.update({ railThreadSources: this.state.railThreadSources.filter((entry) => entry !== source) });
  }

  setRailProjectFilter(projectName: string | undefined): void {
    if (this.state.railProjectFilter !== projectName) this.update({ railProjectFilter: projectName });
  }

  /** The project a thread runs in, as the index lists it; a thread outside every project gets one of its own. */
  openProjectSettings(thread: Pick<UiSession, "projectPath" | "projectName" | "workspaceId">): void {
    const project = this.projectsOf?.().find((entry) => entry.path === thread.projectPath || (thread.workspaceId !== undefined && entry.workspaceId === thread.workspaceId))
      ?? this.projectsOf?.().find((entry) => entry.name === thread.projectName)
      ?? { path: thread.projectPath, name: thread.projectName, lastOpenedAt: 0, ...(thread.workspaceId ? { workspaceId: thread.workspaceId } : {}) };
    this.update({ projectSettings: project });
  }

  closeProjectSettings(): void { this.update({ projectSettings: undefined }); }

  /** The index's projects, lent by the rail once it is drawn. */
  projectsOf?: () => readonly UiProject[];

  /** Once per client; later turns arrive as checkpoint announcements. */
  async loadTurnStats(): Promise<void> {
    if (!hostAvailable()) return;
    try {
      const stats = await this.host.getTurnStats();
      this.update({ turnStats: { ...stats, ...this.state.turnStats } });
    } catch { /* an older host keeps no stats; the rows show none */ }
  }

  /** A turn ended: one that changed files replaces the thread's stat, one that changed none leaves it. */
  recordTurnStat(sessionId: string, stat: TurnStat): void {
    const turnStats = recordTurnStat(this.state.turnStats, sessionId, stat);
    if (turnStats[sessionId] === stat) this.update({ turnStats });
  }

  registerThreadRailOrganizer(organizer: ThreadRailOrganizer): () => void {
    this.update({ threadRailOrganizer: organizer });
    return () => { if (this.state.threadRailOrganizer === organizer) this.update({ threadRailOrganizer: undefined }); };
  }

  registerFileEditor(editor: WorkspaceFileEditor): () => void {
    this.fileEditor = editor;
    return () => { if (this.fileEditor === editor) this.fileEditor = undefined; };
  }

  /** Hands a file to the kit that edits files; false when none offered to. */
  editFile(relPath: string): boolean {
    if (!this.fileEditor || !this.actions) return false;
    this.fileEditor(relPath, this.actions);
    return true;
  }

  registerCommitMessageSuggester(suggester: CommitMessageSuggester): () => void {
    this.commitMessageSuggester = suggester;
    return () => { if (this.commitMessageSuggester === suggester) this.commitMessageSuggester = undefined; };
  }

  async suggestCommitMessage(changes: UiWorkspaceChanges, diffs: readonly UiFileDiff[]): Promise<string | undefined> {
    if (!this.commitMessageSuggester || !this.actions) return undefined;
    // No toast: the commit box shows why, and a missing provider is not worth an interruption.
    return this.commitMessageSuggester({ changes, diffs, actions: this.actions });
  }

  switchRef(ref: string): Promise<boolean> { return this.workspaceAction(() => this.host.switchRef(ref)); }
  /** A worktree whose folder vanished is recreated rather than refused. */
  async openWorktree(path: string): Promise<boolean> {
    if (path === this.state.cwd) return true;
    if (!this.actions) return false;
    if (hostAvailable()) {
      const branch = this.state.workspace?.worktrees.find((tree) => tree.path === path)?.branch;
      try {
        if (await this.host.ensureWorktree(path, branch, this.workspace())) this.notify(`Recreated ${path}.`);
      } catch (error) {
        this.notify(errorMessage(error));
        return false;
      }
    }
    return this.actions.openWorkspace(path);
  }
}

