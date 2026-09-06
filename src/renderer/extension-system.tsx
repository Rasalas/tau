import { chordMatchesEvent, formatKeyChord, isModified, normalizeKeyChord, parseKeyChord, type KeyChord } from "./keybindings";
import type { ComponentType, ReactNode } from "react";
import type { HostClient } from "./host-client";
import type { HostActionResult } from "../shared/host-protocol";
import type {
  GlobalHostEvent,
  HostEvent,
  HostSnapshot,
  ShellActionResult,
  UiToolRun,
  ExtensionUiAnswer,
  ExtensionUiPrompt,
} from "../shared/contracts";
import type { DiffLoadOptions, UiFileContent, UiEditor, UiFileDiff, UiWorkspaceChanges } from "../shared/workspace-kit-types";
import { PreferencesStore } from "./preferences";

/**
 * Desktop-side extension seam. The workbench owns placement and lifecycle;
 * extensions own panels, sidebar modules, project sources, commands and tool presentation.
 */
export interface WorkbenchActions {
  openPanel(id: string): void;
  openCommandPalette(): void;
  openSettings(page?: string): void;
  newSession(): void;
  switchSession(path: string): Promise<boolean>;
  settleActiveThread(): void;
  abort(): void;
  /** Builds Tau, reloads Pi resources and desktop extensions, then restarts the app when required. */
  reloadWorkbench(): Promise<boolean>;
  /** Pi's /tree and /fork: the session tree of the active thread, to move in or fork from. */
  openThreadTree(mode?: "navigate" | "fork"): void;
  /** Pi's /clone: a new thread continuing from the active thread's current point. */
  duplicateThread(): Promise<boolean>;
  focusComposer(seed?: string): void;
  notify(message: string): void;
  /** Opens the list of project sources extensions registered. */
  openProjectSources(): void;
  /** Opens a project like the sidebar does, named by its workspace id; `inheritDraft` carries the unsent composer text into the thread that opens there. */
  openWorkspace(workspace: string, options?: { inheritDraft?: boolean }): Promise<boolean>;
  /**
   * The thread on screen: its id and model, the project it runs in (a pending
   * draft's project while the thread does not exist yet), and whether that draft is still pending.
   */
  activeThread(): { sessionId?: string; cwd?: string; workspaceId?: string; model?: { provider: string; id: string }; draftPending: boolean } | undefined;
  /** Opens a document in the stage, as source or as its working-tree diff. */
  openFile(path: string, options?: { pin?: boolean; view?: "source" | "diff" }): void;
  /** Runs a shell command the way Pi's `!` does; output goes to the thread when asked. */
  runShellAction(command: string, includeInContext: boolean): Promise<ShellActionResult>;
  /** Keeps the composer from submitting until the returned release is called. */
  holdComposer(): () => void;
  /** What the user has typed into the visible composer and not sent yet. */
  composerDraft(): string;
  /** Applies a host action result the way core actions do, refreshing what it touched. */
  applyHostResult(result: HostActionResult): void;
  /** Puts text on the host's clipboard. */
  copyText(text: string): Promise<void>;
  /** Shows a registered overlay in place of the workbench; `closeOverlay` returns. */
  openOverlay(id: string): void;
  closeOverlay(): void;
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

/**
 * A row an extension places in the transcript after the message it belongs to.
 * The transcript resolves `afterMessageId` against loaded messages and their
 * source entries; a row whose anchor is not loaded stays hidden until its page is.
 */
export interface TranscriptRow {
  id: string;
  afterMessageId?: string;
  /** Keep a transient row visible at the tail while its anchor is still racing in. */
  fallbackToTail?: boolean;
  content: ReactNode;
}

/** Handle an extension keeps to publish rows per thread; disposal removes them all. */
export interface TranscriptRowsHandle {
  setRows(sessionId: string, rows: readonly TranscriptRow[]): void;
  clear(sessionId?: string): void;
  dispose(): void;
}

/**
 * Places the workbench lends to extensions. Core renders the region, never its
 * content: above or below the composer (Pi's widgets), at the head or foot of
 * the transcript, or as the status line at the bottom, Pi's footer.
 */
export type RegionPlacement = "title-bar" | "composer-above" | "composer-below" | "transcript-header" | "transcript-footer";

export interface RegionProps {
  snapshot?: HostSnapshot;
  actions: WorkbenchActions;
}

export interface RegionContribution {
  id: string;
  placement: RegionPlacement;
  order?: number;
  Component: ComponentType<RegionProps>;
}

/** One item of the status line; `align` decides the side, `order` the position within it. */
export interface StatusItemContribution {
  id: string;
  order?: number;
  align?: "left" | "right";
  Component: ComponentType<RegionProps>;
}

export interface OverlayProps {
  actions: WorkbenchActions;
  onClose(): void;
}

/** A full-workbench view an extension opens with `actions.openOverlay(id)`. */
export interface OverlayContribution {
  id: string;
  Component: ComponentType<OverlayProps>;
}

/** Host events the workbench forwards to extensions; the rest stays core state. */
export type WorkbenchEvent =
  | Extract<HostEvent, { type: "tool-start" | "tool-end" | "agent-status" | "user-message" | "assistant-end" | "thread-index" | "notice" }>
  | { type: "active-thread-changed"; sessionId?: string };

export type WorkbenchEventType = WorkbenchEvent["type"];

export interface WorkbenchEvents {
  on<T extends WorkbenchEventType>(type: T, listener: (event: Extract<WorkbenchEvent, { type: T }>) => void): () => void;
}

/** A control rendered in the composer's toolbar row, beside model and thinking. */
export interface ComposerControlProps {
  snapshot?: HostSnapshot;
}

export interface ComposerControlContribution {
  id: string;
  order?: number;
  /** `toolbar` sits beside model and thinking; `footer` spans the row below the editor. */
  placement?: "toolbar" | "footer";
  Component: ComponentType<ComposerControlProps>;
}

export interface PanelProps {
  active: boolean;
  /** Name of the extension that contributed this panel, for the panel header. */
  extensionName: string;
  actions: WorkbenchActions;
}

export interface PanelContribution {
  id: string;
  label: string;
  glyph: string;
  order?: number;
  Component: ComponentType<PanelProps>;
}

/** Places besides the palette where a command may also be offered. */
export type CommandSurface = "thread-title";

export interface CommandContribution {
  id: string;
  label: string;
  group: string;
  surfaces?: readonly CommandSurface[];
  run(actions: WorkbenchActions): void | Promise<void>;
}

/**
 * A key chord that runs a command. Spelling follows Pi's keybindings.json
 * ("ctrl+shift+p", "escape") plus "mod" for ⌘ on macOS and Ctrl elsewhere.
 * The first binding of a chord wins; later ones are recorded as conflicts.
 */
export interface KeybindingContribution {
  keys: string;
  commandId: string;
}

export interface KeybindingConflict {
  keys: string;
  commandId: string;
  extensionId: string;
  /** The binding that holds the chord. */
  boundTo: { commandId: string; extensionId: string };
}

export interface ResolvedKeybinding extends KeybindingContribution, ContributionOwner {
  /** Platform spelling for display, e.g. ⌘K. */
  label: string;
  chord: KeyChord;
}

/** A `/name` the composer runs in the workbench instead of sending it to the runtime. */
export interface SlashCommandContribution {
  /** Invocation without the leading slash, e.g. `reload`. */
  name: string;
  description?: string;
  argumentHint?: string;
  /** Returns a message to show when the command could not do its work. */
  run(args: string, actions: WorkbenchActions): void | string | Promise<void | string>;
}

export interface PromptRendererProps {
  prompt: ExtensionUiPrompt;
  /** Further questions queued behind this one. */
  pending: number;
  onAnswer(value: string | boolean, typed?: boolean): void;
  onCancel(): void;
}

/**
 * Takes over the rendering of Pi dialogs it recognises, usually by a marker its
 * host entry left in `prompt.extras`. Core renders the four dialogs otherwise.
 */
export interface PromptRendererContribution {
  id: string;
  match(prompt: ExtensionUiPrompt): boolean;
  Component: ComponentType<PromptRendererProps>;
  /** An answer known before the question shows; core sends it and never renders the prompt. */
  intercept?(prompt: ExtensionUiPrompt): ExtensionUiAnswer | undefined;
  /** Every answer core sends for a matched prompt, including free text typed in the composer. */
  onAnswered?(prompt: ExtensionUiPrompt, answer: ExtensionUiAnswer): void;
}

export interface PromptSubmittedEvent {
  prompt: string;
  snapshot?: HostSnapshot;
}

export interface PromptHookContribution {
  id: string;
  afterPrompt(event: PromptSubmittedEvent, actions: WorkbenchActions): void | Promise<void>;
}

/** Who loads the stage's documents and knows which are changed. One at a time. */
export interface DocumentSourceContribution {
  id: string;
  loadFile(path: string): Promise<UiFileContent>;
  loadDiff(path: string, options?: DiffLoadOptions): Promise<UiFileDiff>;
  openInEditor(relPath: string): void;
  getState(): { changes: UiWorkspaceChanges; editor?: UiEditor };
  subscribe(listener: () => void): () => void;
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
  | { id: string; kind: "chips"; label: string; values: string[] }
  | { id: string; kind: "select"; label: string; values: Array<{ value: string; label: string }>; defaultValue: string }
  /** A model choice, stored as `provider/id` under the extension's values; unset means the thread's model. */
  | { id: string; kind: "model"; label: string };

/**
 * How threads relate to one another, published by the extension that made the
 * relation. Core owns threads (ADR 0003); the navigator that draws them is an
 * extension, so lineage travels between the two as data rather than a import.
 */
export interface ThreadLineage {
  /** Child thread id to its parent's thread id. */
  parents: Readonly<Record<string, string>>;
  /** Parent thread id to how many of its children are working right now. */
  workingChildren: Readonly<Record<string, number>>;
}

export const EMPTY_THREAD_LINEAGE: ThreadLineage = { parents: {}, workingChildren: {} };

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
  /** Core host events this extension may react to; listeners go with deactivation. */
  events: WorkbenchEvents;
  /** The renderer's shared preferences store; extensions read and write through it instead of importing a singleton. */
  preferences: PreferencesStore;
  registerRegion(region: RegionContribution): () => void;
  registerStatusItem(item: StatusItemContribution): () => void;
  registerOverlay(overlay: OverlayContribution): () => void;
  registerPanel(panel: PanelContribution): () => void;
  registerComposerControl(control: ComposerControlContribution): () => void;
  /** Rows this extension shows in the transcript; `order` sorts rows sharing an anchor. */
  registerTranscriptRows(id: string, order?: number): TranscriptRowsHandle;
  /** Replaces the transcript's waiting label for a thread while the label is set; `undefined` clears it. */
  setLiveStatus(sessionId: string, label: string | undefined): void;
  /** Publishes how threads this extension created relate to their parents; `undefined` withdraws it. */
  setThreadLineage(lineage: ThreadLineage | undefined): void;
  /**
   * Publishes a value the extensions of one product may share, under an id
   * their own protocol file names. Core never looks inside it, and the offer
   * is withdrawn when this extension deactivates.
   */
  provideService<T>(id: string, value: T): () => void;
  /**
   * Uses a value another extension published, now or as soon as it appears —
   * so activation order does not matter. `use` may return its own disposer,
   * which runs when the provider withdraws or this extension deactivates.
   */
  useService<T>(id: string, use: (value: T) => (() => void) | void): () => void;
  registerSidebar(contribution: SidebarContribution): () => void;
  registerProjectSource(source: ProjectSourceContribution): () => void;
  registerCommand(command: CommandContribution): () => void;
  /** Slash commands show in the composer's `/` menu next to the runtime's own. */
  registerSlashCommand(command: SlashCommandContribution): () => void;
  /** Binds a chord to a command of any extension; core dispatches window keydown. */
  registerKeybinding(binding: KeybindingContribution): () => void;
  registerPromptHook(hook: PromptHookContribution): () => void;
  registerPromptRenderer(renderer: PromptRendererContribution): () => void;
  /** The stage shows documents; one extension says how to load them and which are changed. */
  registerDocumentSource(source: DocumentSourceContribution): () => void;
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
  permissions?: readonly string[];
  granted?: boolean;
  activate(context: DesktopExtensionContext): void | (() => void);
}

export interface ExtensionSummary {
  id: string;
  name: string;
  active: boolean;
  /** Human-readable list of what this extension contributed, e.g. "sidebar · files · changes". */
  contributes: string;
  options: ExtensionOption[];
  permissions?: readonly string[];
  /** Where the package's host half runs; only a package awaiting approval carries it. */
  isolation?: "worker" | "in-process";
  granted?: boolean;
}

interface ToolRenderer {
  id: string;
  match: (tool: UiToolRun) => boolean;
  render: (tool: UiToolRun) => ToolPresentation;
}

type Owned<T> = T & ContributionOwner;

/** One `useService` registration: the callback and whatever it left behind. */
interface ServiceUser {
  use(value: unknown): (() => void) | void;
  dispose?: () => void;
}

/** Thrown when there is no host to route to, e.g. in the browser preview. */
export class HostUnavailableError extends Error {
  constructor() { super("The Electron host is not available."); this.name = "HostUnavailableError"; }
}

const noHostBridge: HostExtensionBridge = {
  invoke: () => Promise.reject(new HostUnavailableError()),
};

/** Generalizes the desktop API's `invokeHostExtension` to whatever `HostClient` is active. */
export function hostExtensionBridge(client: HostClient | undefined): HostExtensionBridge {
  return {
    invoke: (extensionId, command, input) => client
      ? client.invokeHostExtension(extensionId, command, input)
      : Promise.reject(new HostUnavailableError()),
  };
}

export class ExtensionRegistry {
  private readonly hostEventListeners = new Map<string, Map<string, Set<(payload: unknown) => void>>>();

  private readonly services: { preferences: PreferencesStore };

  // `services` defaults to a private store so the many tests that build a
  // registry without a workbench keep working; real activation passes the
  // renderer's shared instance explicitly.
  constructor(
    private readonly hostBridge: HostExtensionBridge = noHostBridge,
    services?: { preferences: PreferencesStore },
  ) {
    this.services = services ?? { preferences: new PreferencesStore() };
  }

  private panels = new Map<string, Owned<PanelContribution>>();
  private composerControls = new Map<string, Owned<ComposerControlContribution>>();
  private regions = new Map<string, Owned<RegionContribution>>();
  private statusItems = new Map<string, Owned<StatusItemContribution>>();
  private overlays = new Map<string, Owned<OverlayContribution>>();
  private readonly workbenchEventListeners = new Map<WorkbenchEventType, Set<(event: WorkbenchEvent) => void>>();
  private transcriptRows = new Map<string, { order: number; owner: ContributionOwner; bySession: Map<string, readonly TranscriptRow[]> }>();
  /** Waiting labels per extension and thread; the first extension's label wins. */
  private liveStatuses = new Map<string, Map<string, string>>();
  /** Thread lineage per extension; entries merge, the first extension's answer wins. */
  private lineages = new Map<string, ThreadLineage>();
  private lineageCache: { version: number; value: ThreadLineage } | undefined;
  private sidebarContributions = new Map<string, Owned<SidebarContribution>>();
  private projectSources = new Map<string, Owned<ProjectSourceContribution>>();
  private commands = new Map<string, Owned<CommandContribution>>();
  private slashCommands = new Map<string, Owned<SlashCommandContribution>>();
  private keybindings = new Map<string, ResolvedKeybinding>();
  private keybindingConflicts: KeybindingConflict[] = [];
  private promptHooks = new Map<string, Owned<PromptHookContribution>>();
  private promptRenderers = new Map<string, Owned<PromptRendererContribution>>();
  private documentSources = new Map<string, Owned<DocumentSourceContribution>>();
  /** Values one extension published for another; core only routes them by id. */
  private extensionServices = new Map<string, ContributionOwner & { value: unknown }>();
  private serviceUsers = new Map<string, Set<ServiceUser>>();
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
      preferences: this.services.preferences,
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
      events: {
        on: (type, listener) => {
          const listeners = this.workbenchEventListeners.get(type) ?? new Set<(event: WorkbenchEvent) => void>();
          this.workbenchEventListeners.set(type, listeners);
          const wrapped = listener as (event: WorkbenchEvent) => void;
          listeners.add(wrapped);
          const dispose = () => { listeners.delete(wrapped); };
          disposers.push(dispose);
          return dispose;
        },
      },
      registerRegion: (region) => {
        note(`${region.placement} region`);
        return this.register(this.regions, region.id, { ...region, ...owner }, disposers);
      },
      registerStatusItem: (item) => {
        note("status line");
        return this.register(this.statusItems, item.id, { ...item, ...owner }, disposers);
      },
      registerOverlay: (overlay) => {
        note("overlay");
        return this.register(this.overlays, overlay.id, { ...overlay, ...owner }, disposers);
      },
      setLiveStatus: (sessionId, label) => {
        const own = this.liveStatuses.get(extension.id) ?? new Map<string, string>();
        if (label === undefined) own.delete(sessionId);
        else own.set(sessionId, label);
        if (own.size === 0) this.liveStatuses.delete(extension.id);
        else this.liveStatuses.set(extension.id, own);
        this.changed();
      },
      setThreadLineage: (lineage) => {
        if (lineage) this.lineages.set(extension.id, lineage);
        else this.lineages.delete(extension.id);
        this.changed();
      },
      registerTranscriptRows: (id, order = 0) => {
        note("transcript rows");
        if (this.transcriptRows.has(id)) throw new Error(`Contribution id ${id} from ${extension.id} collides with another transcript row source`);
        const source = { order, owner, bySession: new Map<string, readonly TranscriptRow[]>() };
        this.transcriptRows.set(id, source);
        const dispose = () => {
          if (this.transcriptRows.get(id) === source) this.transcriptRows.delete(id);
          this.changed();
        };
        disposers.push(dispose);
        this.changed();
        return {
          setRows: (sessionId, rows) => {
            if (this.transcriptRows.get(id) !== source) return;
            if (rows.length === 0) source.bySession.delete(sessionId);
            else source.bySession.set(sessionId, rows);
            this.changed();
          },
          clear: (sessionId) => {
            if (sessionId === undefined) source.bySession.clear();
            else source.bySession.delete(sessionId);
            this.changed();
          },
          dispose,
        };
      },
      registerComposerControl: (control) => {
        note("composer controls");
        return this.register(this.composerControls, control.id, { ...control, ...owner }, disposers);
      },
      provideService: (id, value) => {
        const held = this.extensionServices.get(id);
        if (held) throw new Error(`Extension service ${id} is already provided by ${held.extensionId}`);
        note("services");
        this.extensionServices.set(id, { value, ...owner });
        this.rebindServiceUsers(id, value);
        const dispose = () => {
          if (this.extensionServices.get(id)?.extensionId !== extension.id) return;
          this.extensionServices.delete(id);
          this.releaseServiceUsers(id);
          this.changed();
        };
        disposers.push(dispose);
        this.changed();
        return dispose;
      },
      useService: (id, use) => {
        const user: ServiceUser = { use: use as ServiceUser["use"] };
        const users = this.serviceUsers.get(id) ?? new Set<ServiceUser>();
        this.serviceUsers.set(id, users);
        users.add(user);
        const held = this.extensionServices.get(id);
        if (held) user.dispose = user.use(held.value) ?? undefined;
        const dispose = () => {
          users.delete(user);
          user.dispose?.();
          user.dispose = undefined;
        };
        disposers.push(dispose);
        return dispose;
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
      registerKeybinding: (binding) => {
        const chord = parseKeyChord(binding.keys);
        const id = normalizeKeyChord(binding.keys);
        if (!chord || !id) throw new Error(`Keybinding "${binding.keys}" from ${extension.id} is not a key chord`);
        note("keybindings");
        const existing = this.keybindings.get(id);
        if (existing) {
          const conflict: KeybindingConflict = { keys: id, commandId: binding.commandId, extensionId: extension.id, boundTo: { commandId: existing.commandId, extensionId: existing.extensionId } };
          this.keybindingConflicts.push(conflict);
          console.warn(`Keybinding ${id} from ${extension.id} (${binding.commandId}) is already bound to ${existing.commandId} by ${existing.extensionId}; keeping the first.`);
          const dispose = () => {
            this.keybindingConflicts = this.keybindingConflicts.filter((entry) => entry !== conflict);
            this.changed();
          };
          disposers.push(dispose);
          this.changed();
          return dispose;
        }
        return this.register(this.keybindings, id, { ...binding, keys: id, chord, label: formatKeyChord(chord), ...owner }, disposers);
      },
      registerSlashCommand: (command) => {
        if (!/^[a-z][a-z0-9:-]*$/u.test(command.name)) throw new Error(`Slash command name "${command.name}" from ${extension.id} must be lowercase letters, digits, ":" or "-"`);
        note("slash commands");
        return this.register(this.slashCommands, command.name, { ...command, ...owner }, disposers);
      },
      registerPromptRenderer: (renderer) => {
        note("prompt renderers");
        return this.register(this.promptRenderers, renderer.id, { ...renderer, ...owner }, disposers);
      },
      registerPromptHook: (hook) => {
        note("prompt hooks");
        return this.register(this.promptHooks, hook.id, { ...hook, ...owner }, disposers);
      },
      registerDocumentSource: (source) => {
        note("documents");
        return this.register(this.documentSources, source.id, { ...source, ...owner }, disposers);
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
      if (cleanupError) throw new AggregateError([error, cleanupError], `Extension ${extension.id} activation and cleanup failed`, { cause: error });
      throw error;
    }
  }

  private rebindServiceUsers(id: string, value: unknown): void {
    for (const user of this.serviceUsers.get(id) ?? []) {
      user.dispose?.();
      user.dispose = user.use(value) ?? undefined;
    }
  }

  private releaseServiceUsers(id: string): void {
    for (const user of this.serviceUsers.get(id) ?? []) {
      user.dispose?.();
      user.dispose = undefined;
    }
  }

  /** Ids of the values extensions have published for one another. */
  getServiceIds(): string[] {
    return [...this.extensionServices.keys()];
  }

  deactivate(id: string): void {
    const active = this.activeExtensions.get(id);
    if (!active) return;
    let cleanupError: unknown;
    try { active.dispose(); } catch (error) { cleanupError = error; }
    this.activeExtensions.delete(id);
    this.contributionKinds.delete(id);
    this.liveStatuses.delete(id);
    this.lineages.delete(id);
    this.changed();
    if (cleanupError) throw cleanupError;
  }

  /** Records the user's answer on a known extension so the settings page stops asking. */
  setGranted(id: string, granted: boolean): void {
    const extension = this.known.get(id);
    if (!extension) return;
    extension.granted = granted;
    this.changed();
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

  /** The waiting label an extension set for a thread, if any. */
  getLiveStatus(sessionId: string | undefined): string | undefined {
    if (!sessionId) return undefined;
    for (const own of this.liveStatuses.values()) {
      const label = own.get(sessionId);
      if (label !== undefined) return label;
    }
    return undefined;
  }

  /** Lineage of every extension, merged into one map the navigator can read. */
  getThreadLineage(): ThreadLineage {
    if (this.lineageCache?.version === this.version) return this.lineageCache.value;
    const value: ThreadLineage = this.lineages.size === 0
      ? EMPTY_THREAD_LINEAGE
      : [...this.lineages.values()].reduce((merged, lineage) => ({
        parents: { ...lineage.parents, ...merged.parents },
        workingChildren: { ...lineage.workingChildren, ...merged.workingChildren },
      }), EMPTY_THREAD_LINEAGE);
    this.lineageCache = { version: this.version, value };
    return value;
  }

  /** Rows every extension published for one thread, sorted by source order; ids are namespaced by source. */
  getTranscriptRows(sessionId: string | undefined): TranscriptRow[] {
    if (!sessionId) return [];
    const key = `transcript-rows:${sessionId}`;
    const cached = this.sortedCache.get(key);
    if (cached?.version === this.version) return cached.value as TranscriptRow[];
    const value = [...this.transcriptRows.entries()]
      .sort(([, a], [, b]) => a.order - b.order)
      .flatMap(([id, source]) => (source.bySession.get(sessionId) ?? []).map((row) => ({ ...row, id: `${id}:${row.id}` })));
    this.sortedCache.set(key, { version: this.version, value });
    return value;
  }

  getRegions(placement: RegionPlacement): Array<Owned<RegionContribution>> {
    const key = `regions:placed:${placement}`;
    const cached = this.sortedCache.get(key);
    if (cached?.version === this.version) return cached.value as Array<Owned<RegionContribution>>;
    const value = this.sorted(`regions:${placement}`, this.regions).filter((region) => region.placement === placement);
    this.sortedCache.set(key, { version: this.version, value });
    return value;
  }

  getStatusItems(): Array<Owned<StatusItemContribution>> {
    return this.sorted("status-items", this.statusItems);
  }

  getOverlay(id: string | undefined): Owned<OverlayContribution> | undefined {
    return id ? this.overlays.get(id) : undefined;
  }

  /** Forwards one core event to the extensions listening for its type. */
  dispatchWorkbenchEvent(event: WorkbenchEvent): void {
    const listeners = this.workbenchEventListeners.get(event.type);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try { listener(event); } catch (error) { console.error(`Extension listener for ${event.type} failed`, error); }
    }
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

  getCommandsFor(surface: CommandSurface): Array<Owned<CommandContribution>> {
    const key = `commands:${surface}`;
    const cached = this.sortedCache.get(key);
    if (cached?.version === this.version) return cached.value as Array<Owned<CommandContribution>>;
    const value = this.getCommands().filter((command) => command.surfaces?.includes(surface));
    this.sortedCache.set(key, { version: this.version, value });
    return value;
  }

  getKeybindings(): ResolvedKeybinding[] {
    return this.sorted("keybindings", this.keybindings, false);
  }

  getKeybindingConflicts(): readonly KeybindingConflict[] {
    return this.keybindingConflicts;
  }

  /** The display label of the chord bound to a command, if any. */
  keybindingLabel(commandId: string): string | undefined {
    for (const binding of this.keybindings.values()) if (binding.commandId === commandId) return binding.label;
    return undefined;
  }

  /** The command a keydown event should run; `modified` tells bare keys from chords with modifiers. */
  matchKeybinding(event: KeyboardEvent): { command: Owned<CommandContribution>; binding: ResolvedKeybinding; modified: boolean } | undefined {
    for (const binding of this.keybindings.values()) {
      if (!chordMatchesEvent(binding.chord, event)) continue;
      const command = this.commands.get(binding.commandId);
      return command ? { command, binding, modified: isModified(binding.chord) } : undefined;
    }
    return undefined;
  }

  getSlashCommands(): Array<Owned<SlashCommandContribution>> {
    return this.sorted("slash-commands", this.slashCommands, false);
  }

  /** Splits `/name rest` and finds the desktop command for it, if any. */
  findSlashCommand(text: string): { command: Owned<SlashCommandContribution>; args: string } | undefined {
    const match = /^\/([^\s]+)(?:\s+([^]*))?$/u.exec(text.trim());
    if (!match) return undefined;
    const command = this.slashCommands.get(match[1]!);
    return command ? { command, args: (match[2] ?? "").trim() } : undefined;
  }

  getPromptRenderer(prompt: ExtensionUiPrompt): Owned<PromptRendererContribution> | undefined {
    for (const renderer of this.promptRenderers.values()) if (renderer.match(prompt)) return renderer;
    return undefined;
  }

  /** An answer a renderer already knows for this prompt, if any. */
  interceptPrompt(prompt: ExtensionUiPrompt): ExtensionUiAnswer | undefined {
    const renderer = this.getPromptRenderer(prompt);
    try {
      return renderer?.intercept?.(prompt);
    } catch (error) {
      console.error(`Prompt renderer ${renderer?.id} failed to intercept`, error);
      return undefined;
    }
  }

  notifyPromptAnswered(prompt: ExtensionUiPrompt, answer: ExtensionUiAnswer): void {
    const renderer = this.getPromptRenderer(prompt);
    try {
      renderer?.onAnswered?.(prompt, answer);
    } catch (error) {
      console.error(`Prompt renderer ${renderer?.id} failed on answer`, error);
    }
  }

  getDocumentSource(): Owned<DocumentSourceContribution> | undefined {
    return this.sorted("documents", this.documentSources)[0];
  }

  getExtensionSummaries(): ExtensionSummary[] {
    return [...this.known.values()].map((extension) => ({
      id: extension.id,
      name: extension.name,
      active: this.activeExtensions.has(extension.id),
      contributes: (this.contributionKinds.get(extension.id) ?? []).join(" · "),
      options: this.options.get(extension.id) ?? [],
      permissions: extension.permissions,
      granted: extension.granted,
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
