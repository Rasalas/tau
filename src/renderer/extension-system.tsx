import type { ComponentType } from "react";
import type {
  DiffLoadOptions,
  GlobalHostEvent,
  HostSnapshot,
  UiEditor,
  UiFileDiff,
  UiToolRun,
  UiTurnCheckpoint,
  UiWorkspaceChanges,
  UiWorkspaceChangesPage,
  WorkspaceChangesQuery,
} from "../shared/contracts";

/**
 * Desktop-side extension seam. The workbench owns placement and lifecycle;
 * extensions own panels, sidebar modules, project sources, commands and tool presentation.
 */
export interface WorkbenchActions {
  openPanel(id: string): void;
  openCommandPalette(): void;
  openSettings(page?: string): void;
  openReview(): void;
  newSession(): void;
  switchSession(path: string): Promise<boolean>;
  settleActiveThread(): void;
  abort(): void;
  reloadRuntime(): Promise<boolean>;
  /** Rebuilds the workbench from source and reloads it; a changed host still needs a restart. */
  rebuildWorkbench(): Promise<boolean>;
  restartWorkbench(): void;
  focusComposer(seed?: string): void;
  notify(message: string): void;
  chooseWorkspace(): Promise<boolean>;
  openWorkspace(path: string): Promise<boolean>;
  cloneWorkspace(repositoryUrl: string): Promise<boolean>;
  generateThreadTitle(provider: string, modelId: string, force?: boolean): Promise<boolean>;
  /** Regenerate the active thread's title using its own model. */
  regenerateTitle(force?: boolean): Promise<boolean>;
}

/** Stamped onto every contribution so the UI can say which extension supplied it. */
export interface ContributionOwner {
  extensionId: string;
  extensionName: string;
}

export interface SidebarContributionProps {
  actions: WorkbenchActions;
}

export interface SidebarContribution {
  id: string;
  order?: number;
  Component: ComponentType<SidebarContributionProps>;
}

export interface ProjectSourceProps {
  actions: WorkbenchActions;
  onBack(): void;
  onDone(): void;
}

interface ProjectSourceBase {
  id: string;
  label: string;
  description: string;
  glyph: string;
  order?: number;
}

export type ProjectSourceContribution = ProjectSourceBase & (
  | {
      run(actions: WorkbenchActions): boolean | void | Promise<boolean | void>;
      Component?: never;
    }
  | {
      Component: ComponentType<ProjectSourceProps>;
      run?: never;
    }
);

/** A control rendered in the composer's toolbar row, beside model and thinking. */
export interface ComposerControlProps {
  snapshot?: HostSnapshot;
}

export interface ComposerControlContribution {
  id: string;
  order?: number;
  Component: ComponentType<ComposerControlProps>;
}

export interface PanelProps {
  active: boolean;
  /** Name of the extension that contributed this panel, for the panel header. */
  extensionName: string;
}

export interface PanelContribution {
  id: string;
  label: string;
  glyph: string;
  order?: number;
  Component: ComponentType<PanelProps>;
}

export interface CommandContribution {
  id: string;
  label: string;
  group: string;
  shortcut?: string;
  run(actions: WorkbenchActions): void | Promise<void>;
}

export interface PromptSubmittedEvent {
  prompt: string;
  snapshot?: HostSnapshot;
}

export interface PromptHookContribution {
  id: string;
  afterPrompt(event: PromptSubmittedEvent, actions: WorkbenchActions): void | Promise<void>;
}

/** Props for a changes card rendered in a transcript or workspace dock. */
export interface ChangesContributionProps {
  changes: UiWorkspaceChanges;
  onOpenDiff(path?: string): void;
  label?: string;
  /** Loads the next immutable file-list page, when the source is paged. */
  loadFiles?(cursor?: string, limit?: number): Promise<UiWorkspaceChangesPage>;
}

export interface ChangesContribution {
  id: string;
  order?: number;
  Component: ComponentType<ChangesContributionProps>;
}

/** Props for a turn checkpoint card rendered at its assistant anchor. */
export interface TurnCheckpointContributionProps {
  checkpoint: UiTurnCheckpoint;
  onOpenDiff(path?: string): void;
  /** Starts the explicit confirmation flow for destructive restore. */
  onRestore?(): void;
  loadFiles?(cursor?: string, limit?: number): Promise<UiWorkspaceChangesPage>;
}

export interface TurnCheckpointContribution {
  id: string;
  order?: number;
  Component: ComponentType<TurnCheckpointContributionProps>;
}

export type ReviewContributionKind = "workspace" | "historical";

/** Complete review slot owned by an extension; App only supplies generic data/actions. */
export interface ReviewContributionProps {
  changes: UiWorkspaceChanges;
  selectedPath?: string;
  editor?: UiEditor;
  busy: boolean;
  primaryPush: boolean;
  onSelect(path: string): void;
  onBack(): void;
  onCommit(message: string, push: boolean): void;
  onOpenInEditor(path: string): void;
  loadDiff(path: string, options?: DiffLoadOptions): Promise<UiFileDiff>;
  loadFiles?(cursor?: string, limit?: number): Promise<UiWorkspaceChangesPage>;
  loadChanges?(query?: WorkspaceChangesQuery): Promise<UiWorkspaceChanges>;
  workspaceKey?: string;
  readOnly?: boolean;
  checkpointTitle?: string;
}

export interface ReviewContribution {
  id: string;
  kind: ReviewContributionKind;
  order?: number;
  Component: ComponentType<ReviewContributionProps>;
}

export interface ToolPresentation {
  glyph: string;
  title: string;
  tone: "neutral" | "read" | "write" | "shell";
  detail: string;
  /** Structured tools can keep their machine payload out of the transcript. */
  output?: "default" | "hidden";
}

/** Options an extension declares at activation; Tau renders the settings page from these. */
export type ExtensionOption =
  | { id: string; kind: "toggle"; label: string; defaultValue: boolean }
  | { id: string; kind: "chips"; label: string; values: string[] };

/** The host entry of the same extension package, reached by extension id. */
export interface HostExtensionClient {
  /** Invokes a command the host entry registered with `registerCommand`. */
  invoke(command: string, input?: unknown): Promise<unknown>;
  /** Events the host entry publishes with `emit`. */
  onEvent(name: string, listener: (payload: unknown) => void): () => void;
}

/** How the registry reaches host extensions; the desktop API is the default. */
export interface HostExtensionBridge {
  invoke(extensionId: string, command: string, input?: unknown): Promise<unknown>;
}

export type ExtensionEvent = Extract<GlobalHostEvent, { type: "extension-event" }>;

export interface DesktopExtensionContext {
  /** This extension's host entry, if the package has one. */
  host: HostExtensionClient;
  registerPanel(panel: PanelContribution): () => void;
  registerComposerControl(control: ComposerControlContribution): () => void;
  registerSidebar(contribution: SidebarContribution): () => void;
  registerProjectSource(source: ProjectSourceContribution): () => void;
  registerCommand(command: CommandContribution): () => void;
  registerPromptHook(hook: PromptHookContribution): () => void;
  registerChanges(contribution: ChangesContribution): () => void;
  registerTurnCheckpoint(contribution: TurnCheckpointContribution): () => void;
  registerReview(contribution: ReviewContribution): () => void;
  registerOptions(options: ExtensionOption[]): () => void;
  registerToolRenderer(
    id: string,
    match: (tool: UiToolRun) => boolean,
    render: (tool: UiToolRun) => ToolPresentation,
  ): () => void;
}

export interface DesktopExtension {
  id: string;
  name: string;
  activate(context: DesktopExtensionContext): void | (() => void);
}

export interface ExtensionSummary {
  id: string;
  name: string;
  active: boolean;
  /** Human-readable list of what this extension contributed, e.g. "sidebar · files · changes". */
  contributes: string;
  options: ExtensionOption[];
}

interface ToolRenderer {
  id: string;
  match: (tool: UiToolRun) => boolean;
  render: (tool: UiToolRun) => ToolPresentation;
}

type Owned<T> = T & ContributionOwner;

/** Thrown when there is no host to route to, e.g. in the browser preview. */
export class HostUnavailableError extends Error {
  constructor() { super("The Electron host is not available."); this.name = "HostUnavailableError"; }
}

const desktopApiBridge: HostExtensionBridge = {
  invoke: (extensionId, command, input) => window.tau
    ? window.tau.invokeHostExtension(extensionId, command, input)
    : Promise.reject(new HostUnavailableError()),
};

export class ExtensionRegistry {
  private readonly hostEventListeners = new Map<string, Map<string, Set<(payload: unknown) => void>>>();

  constructor(private readonly hostBridge: HostExtensionBridge = desktopApiBridge) {}

  private panels = new Map<string, Owned<PanelContribution>>();
  private composerControls = new Map<string, Owned<ComposerControlContribution>>();
  private sidebarContributions = new Map<string, Owned<SidebarContribution>>();
  private projectSources = new Map<string, Owned<ProjectSourceContribution>>();
  private commands = new Map<string, Owned<CommandContribution>>();
  private promptHooks = new Map<string, Owned<PromptHookContribution>>();
  private changesContributions = new Map<string, Owned<ChangesContribution>>();
  private turnCheckpointContributions = new Map<string, Owned<TurnCheckpointContribution>>();
  private reviewContributions = new Map<string, Owned<ReviewContribution>>();
  private renderers = new Map<string, Owned<ToolRenderer>>();
  private options = new Map<string, ExtensionOption[]>();
  private contributionKinds = new Map<string, string[]>();
  private known = new Map<string, DesktopExtension>();
  private activeExtensions = new Map<string, { extension: DesktopExtension; dispose: () => void }>();
  private listeners = new Set<() => void>();
  private version = 0;
  private sortedCache = new Map<string, { version: number; value: unknown[] }>();

  /** Make an extension known without activating it, so settings can list and enable it. */
  addKnown(extension: DesktopExtension): void {
    this.known.set(extension.id, extension);
    this.changed();
  }

  activate(extension: DesktopExtension): void {
    this.deactivate(extension.id);
    this.known.set(extension.id, extension);
    const owner: ContributionOwner = { extensionId: extension.id, extensionName: extension.name };
    const kinds: string[] = [];
    const disposers: Array<() => void> = [];
    const note = (kind: string) => { if (!kinds.includes(kind)) kinds.push(kind); };
    const context: DesktopExtensionContext = {
      host: {
        invoke: (command, input) => this.hostBridge.invoke(extension.id, command, input),
        onEvent: (name, listener) => {
          const byName = this.hostEventListeners.get(extension.id) ?? new Map<string, Set<(payload: unknown) => void>>();
          this.hostEventListeners.set(extension.id, byName);
          const listeners = byName.get(name) ?? new Set<(payload: unknown) => void>();
          byName.set(name, listeners);
          listeners.add(listener);
          const dispose = () => { listeners.delete(listener); };
          disposers.push(dispose);
          return dispose;
        },
      },
      registerPanel: (panel) => {
        note(panel.label.toLowerCase());
        return this.register(this.panels, panel.id, { ...panel, ...owner }, disposers);
      },
      registerComposerControl: (control) => {
        note("composer controls");
        return this.register(this.composerControls, control.id, { ...control, ...owner }, disposers);
      },
      registerSidebar: (contribution) => {
        note("sidebar");
        return this.register(this.sidebarContributions, contribution.id, { ...contribution, ...owner }, disposers);
      },
      registerProjectSource: (source) => {
        note("project sources");
        return this.register(this.projectSources, source.id, { ...source, ...owner }, disposers);
      },
      registerCommand: (command) =>
        this.register(this.commands, command.id, { ...command, ...owner }, disposers),
      registerPromptHook: (hook) => {
        note("prompt hooks");
        return this.register(this.promptHooks, hook.id, { ...hook, ...owner }, disposers);
      },
      registerChanges: (contribution) => {
        note("changes");
        return this.register(this.changesContributions, contribution.id, { ...contribution, ...owner }, disposers);
      },
      registerTurnCheckpoint: (contribution) => {
        note("turn checkpoints");
        return this.register(this.turnCheckpointContributions, contribution.id, { ...contribution, ...owner }, disposers);
      },
      registerReview: (contribution) => {
        note(contribution.kind === "historical" ? "historical review" : "review");
        return this.register(this.reviewContributions, contribution.id, { ...contribution, ...owner }, disposers);
      },
      registerToolRenderer: (id, match, render) => {
        note("tool renderers");
        return this.register(this.renderers, id, { id, match, render, ...owner }, disposers);
      },
      registerOptions: (options) => {
        if (this.options.has(extension.id)) throw new Error(`Extension ${extension.id} registered options more than once`);
        this.options.set(extension.id, options);
        const dispose = () => {
          this.options.delete(extension.id);
          this.changed();
        };
        disposers.push(dispose);
        this.changed();
        return dispose;
      },
    };
    try {
      const extensionDispose = extension.activate(context);
      if (extensionDispose) disposers.push(extensionDispose);
      this.contributionKinds.set(extension.id, kinds);
      this.activeExtensions.set(extension.id, {
        extension,
        dispose: () => this.disposeAll(disposers),
      });
      this.changed();
    } catch (error) {
      let cleanupError: unknown;
      try { this.disposeAll(disposers); } catch (failure) { cleanupError = failure; }
      this.contributionKinds.delete(extension.id);
      this.activeExtensions.delete(extension.id);
      if (cleanupError) throw new AggregateError([error, cleanupError], `Extension ${extension.id} activation and cleanup failed`);
      throw error;
    }
  }

  deactivate(id: string): void {
    const active = this.activeExtensions.get(id);
    if (!active) return;
    let cleanupError: unknown;
    try { active.dispose(); } catch (error) { cleanupError = error; }
    this.activeExtensions.delete(id);
    this.contributionKinds.delete(id);
    this.changed();
    if (cleanupError) throw cleanupError;
  }

  setActive(id: string, active: boolean): void {
    if (active) {
      const extension = this.known.get(id);
      if (extension && !this.activeExtensions.has(id)) this.activate(extension);
    } else {
      this.deactivate(id);
    }
  }

  isActive(id: string): boolean {
    return this.activeExtensions.has(id);
  }

  getPanels(): Array<Owned<PanelContribution>> {
    return this.sorted("panels", this.panels);
  }

  getComposerControls(): Array<Owned<ComposerControlContribution>> {
    return this.sorted("composer-controls", this.composerControls);
  }

  getSidebarContributions(): Array<Owned<SidebarContribution>> {
    return this.sorted("sidebar", this.sidebarContributions);
  }

  getProjectSources(): Array<Owned<ProjectSourceContribution>> {
    return this.sorted("sources", this.projectSources);
  }

  getCommands(): Array<Owned<CommandContribution>> {
    return this.sorted("commands", this.commands, false);
  }

  getChangesContributions(): Array<Owned<ChangesContribution>> {
    return this.sorted("changes", this.changesContributions);
  }

  getTurnCheckpointContributions(): Array<Owned<TurnCheckpointContribution>> {
    return this.sorted("turn-checkpoints", this.turnCheckpointContributions);
  }

  getReviewContributions(kind?: ReviewContributionKind): Array<Owned<ReviewContribution>> {
    const contributions = this.sorted("review", this.reviewContributions);
    return kind ? contributions.filter((contribution) => contribution.kind === kind) : contributions;
  }

  getExtensionSummaries(): ExtensionSummary[] {
    return [...this.known.values()].map((extension) => ({
      id: extension.id,
      name: extension.name,
      active: this.activeExtensions.has(extension.id),
      contributes: (this.contributionKinds.get(extension.id) ?? []).join(" · "),
      options: this.options.get(extension.id) ?? [],
    }));
  }

  async notifyPromptSubmitted(event: PromptSubmittedEvent, actions: WorkbenchActions): Promise<void> {
    for (const hook of this.promptHooks.values()) {
      try {
        await hook.afterPrompt(event, actions);
      } catch (error) {
        actions.notify(`${hook.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Routes a host extension event to the desktop entry that subscribed to it. */
  dispatchExtensionEvent(event: ExtensionEvent): void {
    const listeners = this.hostEventListeners.get(event.extensionId)?.get(event.name);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try { listener(event.payload); } catch (error) { console.error(`Extension ${event.extensionId} event handler failed`, error); }
    }
  }

  getExtensionNames(): string[] {
    return [...this.activeExtensions.values()].map(({ extension }) => extension.name);
  }

  presentTool(tool: UiToolRun): ToolPresentation {
    for (const renderer of this.renderers.values()) {
      if (renderer.match(tool)) return renderer.render(tool);
    }
    return {
      glyph: "◇",
      title: tool.name,
      tone: "neutral",
      detail: Object.keys(tool.args).join(" · ") || "no arguments",
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Cheap identity for useSyncExternalStore — changes whenever contributions change. */
  getVersion = (): number => this.version;

  private disposeAll(disposers: Array<() => void>): void {
    const errors: unknown[] = [];
    for (const dispose of [...disposers].reverse()) {
      try { dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Extension contribution cleanup failed");
  }

  private register<T>(map: Map<string, T>, id: string, value: T, disposers: Array<() => void>): () => void {
    const existing = map.get(id) as (T & Partial<ContributionOwner>) | undefined;
    const incoming = value as T & Partial<ContributionOwner>;
    if (existing) {
      throw new Error(`Contribution id ${id} from ${incoming.extensionId ?? "unknown"} collides with ${existing.extensionId ?? "another extension"}`);
    }
    map.set(id, value);
    const dispose = () => {
      if (map.get(id) === value) map.delete(id);
      this.changed();
    };
    disposers.push(dispose);
    this.changed();
    return dispose;
  }

  private sorted<T>(
    key: string,
    map: Map<string, T>,
    byOrder = true,
  ): T[] {
    const cached = this.sortedCache.get(key);
    if (cached?.version === this.version) return cached.value as T[];
    const value = [...map.values()];
    if (byOrder) value.sort((a, b) =>
      ((a as { order?: number }).order ?? 0) - ((b as { order?: number }).order ?? 0),
    );
    this.sortedCache.set(key, { version: this.version, value });
    return value;
  }

  private changed(): void {
    this.version += 1;
    this.listeners.forEach((listener) => listener());
  }
}
