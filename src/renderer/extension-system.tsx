import { chordMatchesEvent, formatKeyChord, isModified, normalizeKeyChord, parseKeyChord, type KeyChord } from "./keybindings";
import type { ComponentType, ReactNode } from "react";
import type { PanelIconComponent } from "./components/PanelIcon";
import type { HostClient } from "../workbench/host-client";
import type { HostActionResult } from "../shared/host-protocol";
import type {
  ExtensionInspection,
  GlobalHostEvent,
  HostEvent,
  HostSnapshot,
  ShellActionResult,
  UiPromptAttachment,
  UiToolRun,
  ExtensionUiAnswer,
  ExtensionUiPrompt,
} from "../shared/contracts";
import type { DiffLoadOptions, UiFileContent, UiEditor, UiFileDiff, UiWorkspaceChanges } from "../shared/workspace-kit-types";
import type { StageTab } from "../workbench/stage";
import { PreferencesStore } from "./preferences";
import { DEFAULT_CLIENT_PROFILES, rendersOnProfile, type ClientProfile, type ProfiledContribution, type ProfileScoped } from "../workbench/client-profile";

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
  /** Creates and opens the editable source tree used by an installed Tau. */
  openWorkbenchSource(): Promise<boolean>;
  /** Pi's /tree and /fork: the session tree of the active thread, to move in or fork from. */
  openThreadTree(mode?: "navigate" | "fork"): void;
  /** Pi's /clone: a new thread continuing from the active thread's current point. */
  duplicateThread(): Promise<boolean>;
  focusComposer(seed?: string): void;
  focusTranscript(): void;
  focusStage(): void;
  toggleDock(): void;
  notify(message: string): void;
  /** Opens the list of project sources extensions registered. */
  openProjectSources(): void;
  /** Opens a project like the sidebar does, named by its workspace id; `inheritDraft` carries the unsent composer text into the thread that opens there. */
  openWorkspace(workspace: string, options?: { inheritDraft?: boolean }): Promise<boolean>;
  /**
   * The thread on screen: its id, model and runtime owner, the project it runs
   * in (a pending draft's project while the thread does not exist yet), and
   * whether that draft is still pending.
   */
  activeThread(): { sessionId?: string; cwd?: string; workspaceId?: string; model?: { provider: string; id: string }; backendKind?: string; draftPending: boolean } | undefined;
  /** Opens a document in the stage, as source or as its working-tree diff. */
  openFile(path: string, options?: { pin?: boolean; view?: "source" | "diff" }): void;
  /** Opens a thread in the stage as a read-only tab, leaving the active thread alone. */
  openThread(sessionId: string, options?: { pin?: boolean }): void;
  /**
   * Opens a tab of a kind an extension registered with `registerStageTab` and
   * answers with its tab id. Two opens with the same params are the same tab;
   * `key` names one explicitly, `preview` asks for the stage's preview slot.
   */
  openStageTab(kind: string, params?: Record<string, unknown>, options?: { preview?: boolean; key?: string }): string;
  /** Closes a stage tab of any kind, asking first when it says it has unsaved work. */
  closeStageTab(id: string): void;
  /** Every tab on the stage, in strip order. */
  stageTabs(): readonly StageTab[];
  /** Runs a shell command the way Pi's `!` does; output goes to the thread when asked. */
  runShellAction(command: string, includeInContext: boolean): Promise<ShellActionResult>;
  /** Keeps the composer from submitting until the returned release is called. */
  holdComposer(): () => void;
  /** What the user has typed into the visible composer and not sent yet. */
  composerDraft(): string;
  /** Sets what is typed into the visible composer. */
  setComposerDraft?(text: string): void;
  /** Opens the current prompt draft in the external editor ($VISUAL/$EDITOR). */
  openPromptEditor?(): Promise<void>;
  /** Applies a host action result the way core actions do, refreshing what it touched. */
  applyHostResult(result: HostActionResult): void;
  /** Closes the stage tab currently on screen. */
  closeActiveStageTab?(): void;
  /** Moves forward or backward through stage tabs. */
  cycleStageTab?(direction: 1 | -1): void;
  /** Puts text on the user's clipboard. */
  copyText(text: string): Promise<void>;
  /** Opens a URL outside the workbench, in whatever the client calls a browser. */
  openExternal(url: string): void;
  /** Shows a registered overlay in place of the workbench; `closeOverlay` returns. */
  openOverlay(id: string): void;
  closeOverlay(): void;
  /** Manually compact the active thread's context window. */
  compactContext?(): Promise<void>;
  /** Opens the model picker modal for selecting a model. */
  openModelPicker?(): void;
  /** Sets the model for the active thread or pending new thread. Accepts (provider, id) or query string. */
  setModel?(provider: string, id?: string): Promise<boolean> | void;
  /** Sets the thinking level for the active thread. */
  setThinkingLevel?(level: string): Promise<void>;
  /** Opens the active instructions and system prompt modal. */
  openInstructions?(): void;
  /** Executes a command registered with `registerCommand`. */
  executeCommand?(id: string): Promise<void> | void;
  /** Copies the active thread's conversation as Markdown. */
  copyChat?(): Promise<void>;
  /** Renames the active thread / session. */
  renameThread?(title: string): Promise<boolean>;
  /** Cycles to the next or previous model. */
  cycleModel?(direction?: 1 | -1): Promise<boolean>;
  /** Cycles to the next thinking level. */
  cycleThinking?(): Promise<void>;
}

/** Stamped onto every contribution so the UI can say which extension supplied it. */
export interface ContributionOwner {
  extensionId: string;
  extensionName: string;
}

export interface SidebarContributionProps {
  actions: WorkbenchActions;
}

export interface SidebarContribution extends ProfileScoped {
  id: string;
  order?: number;
  Component: ComponentType<SidebarContributionProps>;
}

export interface ProjectSourceProps {
  actions: WorkbenchActions;
  onBack(): void;
  onDone(): void;
}

interface ProjectSourceBase extends ProfileScoped {
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

export interface RegionContribution extends ProfileScoped {
  id: string;
  placement: RegionPlacement;
  order?: number;
  Component: ComponentType<RegionProps>;
}

/** One item of the status line; `align` decides the side, `order` the position within it. */
export interface StatusItemContribution extends ProfileScoped {
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
export interface OverlayContribution extends ProfileScoped {
  id: string;
  Component: ComponentType<OverlayProps>;
}

/** Host events the workbench forwards to extensions; the rest stays core state. */
export type WorkbenchEvent =
  | Extract<HostEvent, { type: "tool-start" | "tool-end" | "agent-status" | "user-message" | "assistant-end" | "thread-index" | "notice" | "client-count" }>
  | { type: "active-thread-changed"; sessionId?: string }
  /** The host opened another project; `from` is absent for the first one this client saw. */
  | { type: "workspace-changed"; from?: string; to: string };

export type WorkbenchEventType = WorkbenchEvent["type"];

export interface WorkbenchEvents {
  on<T extends WorkbenchEventType>(type: T, listener: (event: Extract<WorkbenchEvent, { type: T }>) => void): () => void;
}

/** A control rendered in the composer's toolbar row, beside model and thinking. */
export interface ComposerControlProps {
  snapshot?: HostSnapshot;
}

export interface ComposerControlContribution extends ProfileScoped {
  id: string;
  order?: number;
  /** `toolbar` sits beside model and thinking; `footer` spans the row below the editor. */
  placement?: "toolbar" | "footer";
  Component: ComponentType<ComposerControlProps>;
}

/** One draft of one composer: where an inline contribution is working. */
export interface ComposerInlineContext {
  /** The draft the composer edits. Stable while the draft lives; a new thread's draft gets a new one once the thread exists. */
  scope: string;
  snapshot?: HostSnapshot;
  /** The thread's runtime takes `kind: "file"` attachments; otherwise embed a file as text. */
  fileAttachments: boolean;
  /** The thread's model takes images. */
  imageInput: boolean;
}

export interface ComposerInlineProps extends ComposerInlineContext {
  /** This extension's state beside the draft's text, persisted with it (plain JSON; `undefined` removes it). */
  draftState: { read(): unknown; write(value: unknown): void };
}

/** One row of a trigger's menu. */
export interface ComposerTriggerItem {
  id: string;
  label: string;
  description?: string;
  hint?: string;
}

/**
 * A character that opens a menu at the start of a word, the way `@` lists
 * files. Choosing a row removes the typed trigger and hands the row over.
 */
export interface ComposerTriggerContribution {
  /** One character; `/` and `$` are core's. An extension's `@` replaces core's file list. */
  char: string;
  /** What the menu lists, for its accessible name: "Files", "Pull requests". */
  label: string;
  search(query: string, context: ComposerInlineContext): readonly ComposerTriggerItem[] | Promise<readonly ComposerTriggerItem[]>;
  select(item: ComposerTriggerItem, query: string, context: ComposerInlineContext): void;
}

/** What an inline contribution adds to a prompt that is being sent. */
export interface ComposerSendContribution {
  /** Text core puts before the user's (after it, for a skill). */
  context?: string;
  attachments?: readonly UiPromptAttachment[];
}

/**
 * Typed context inside the composer's input frame: a strip drawn above the
 * text, what it takes from a paste or a drop, its trigger menus, and what it
 * adds to a prompt when one is sent. A `/command` is sent without it.
 */
export interface ComposerInlineContribution extends ProfileScoped {
  id: string;
  Component?: ComponentType<ComposerInlineProps>;
  triggers?: readonly ComposerTriggerContribution[];
  /** Answer `true` to keep pasted text out of the field. */
  pasteText?(text: string, context: ComposerInlineContext): boolean;
  /** Takes files from a drop, a paste or the attach button, and answers with the ones left for core's images. */
  takeFiles?(files: readonly File[], context: ComposerInlineContext): readonly File[];
  /** Whether this draft holds something worth sending on its own; enables Send without text. */
  hasContent?(scope: string): boolean;
  /** Called when what `hasContent` answers may have changed. */
  subscribe?(listener: () => void): () => void;
  /** Runs once per sent prompt; a throw rejects the submission and keeps the draft. */
  prepareSend?(context: ComposerInlineContext & { text: string }): ComposerSendContribution | void | Promise<ComposerSendContribution | void>;
  /** The prompt `prepareSend` contributed to was accepted or refused. */
  settleSend?(scope: string, accepted: boolean): void;
}

export interface PanelProps {
  active: boolean;
  /** Name of the extension that contributed this panel, for the panel header. */
  extensionName: string;
  actions: WorkbenchActions;
}

export interface PanelContribution extends ProfileScoped {
  id: string;
  label: string;
  /** The rail glyph; `lucide-react` is shared, so pass one of its icons. Missing draws core's fallback. */
  Icon?: PanelIconComponent;
  order?: number;
  Component: ComponentType<PanelProps>;
}

/**
 * What a stage tab's content does to its own tab. Core hands one handle per
 * tab and keeps it while the tab lives, so the content may hold on to it.
 */
export interface StageTabHandle {
  /** The tab's id in the stage, the one `actions.closeStageTab` takes. */
  readonly id: string;
  setTitle(title: string): void;
  /** A dot in the tab; closing a dirty tab asks the user first. */
  setDirty(dirty: boolean): void;
  /** Runs when the tab closes, whoever closed it; the returned function unsubscribes. */
  onClose(listener: () => void): () => void;
}

/**
 * A kind of stage tab an extension draws — a terminal, a pull request, a file
 * editor. Core keeps the strip, the placement and the preview and pin rules;
 * the kind supplies the title, the glyph, the content and, for a tab that came
 * back from storage, the answer whether it still names anything.
 */
export interface StageTabContribution<Params extends Record<string, unknown> = Record<string, unknown>> extends ProfileScoped {
  /** What `actions.openStageTab` names; unique across extensions. */
  kind: string;
  title(params: Params): string;
  /** The tab glyph, the way a panel passes one. */
  Icon?: PanelIconComponent;
  render(params: Params, handle: StageTabHandle): ReactNode;
  /** False drops a tab restored from storage whose params name nothing any more. */
  restore?(params: Params): boolean;
  /** One tab for the whole kind, whatever params it is opened with. */
  singleton?: boolean;
}

/** Places besides the palette where a command may also be offered. */
export interface SettingsPageProps {
  /** The open project, for a page that reports what this workspace sees. */
  cwd?: string;
  onNotify(message: string): void;
}

/**
 * A page of the Settings modal an extension owns. Core keeps the modal, its
 * navigation and the pages that must survive safe mode; a page like this one is
 * gone with its extension.
 */
export interface SettingsPageContribution extends ProfileScoped {
  id: string;
  label: string;
  /** The nav glyph, the way a panel passes one. */
  Icon?: PanelIconComponent;
  order?: number;
  Component: ComponentType<SettingsPageProps>;
}

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
  /**
   * A command whose other chords this binding takes the place of, rather than
   * joining. The user who rebound an action in `keybindings.json` means *that*
   * key, not that one and Tau's default too; a kit passes the command id here
   * and core hides the default while the binding lives (Keybindings Kit is the
   * caller). Usually the same id as `commandId`.
   */
  replaces?: string;
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
export interface PromptRendererContribution extends ProfileScoped {
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

/** A new thread's first prompt, while the draft still has no thread. */
export interface NewThreadPromptEvent {
  prompt: string;
  /** How the host names the draft's project. */
  workspaceId?: string;
  projectPath: string;
  /** A line the transcript shows while this gate works; it goes when the gate returns. */
  preparing(message: string): void;
}

/**
 * What a gate decides about a thread that is about to be created. Naming a
 * workspace moves the draft there before the prompt is sent, which is how
 * Workspace Kit fuses a new worktree into the first turn.
 */
export interface NewThreadPromptGate {
  workspace?: { workspaceId: string; displayPath: string; name?: string };
}

export interface PromptHookContribution {
  id: string;
  /**
   * Runs before a pending draft's first prompt leaves the composer. It may move
   * the thread to another project; a failure is reported and the draft stays
   * where it was, so the prompt is never lost to it.
   */
  beforeNewThread?(event: NewThreadPromptEvent, actions: WorkbenchActions): Promise<NewThreadPromptGate | void>;
  afterPrompt?(event: PromptSubmittedEvent, actions: WorkbenchActions): void | Promise<void>;
}

/** Who loads the stage's documents and knows which are changed. One at a time. */
export interface DocumentSourceContribution extends ProfileScoped {
  id: string;
  loadFile(path: string): Promise<UiFileContent>;
  loadDiff(path: string, options?: DiffLoadOptions): Promise<UiFileDiff>;
  openInEditor(relPath: string): void;
  getState(): { changes: UiWorkspaceChanges; editor?: UiEditor };
  subscribe(listener: () => void): () => void;
  listFiles?(): Promise<string[]> | string[];
}

export interface ToolPresentation {
  glyph: string;
  title: string;
  tone: "neutral" | "read" | "write" | "shell";
  detail: string;
  /** Structured tools can keep their machine payload out of the transcript. */
  output?: "default" | "hidden";
  /**
   * What this tool reaches — a browser, a machine, an MCP server. A group
   * summary hoists a named source to the front of its sentence instead of
   * counting the calls as anonymous tools.
   */
  source?: string;
}

export interface ToolCardProps {
  /** Every consecutive call of this card's tools, in the order they ran. */
  tools: readonly UiToolRun[];
  actions: WorkbenchActions;
}

/**
 * A whole batch of consecutive calls drawn as one card instead of a row per
 * call. Core never folds, groups or hides a card: it owns its own status, so a
 * spawn that outlives its turn stays readable. A tool a card claims is not
 * offered to `registerToolRenderer`.
 */
export interface ToolCardContribution extends ProfileScoped {
  id: string;
  match(tool: UiToolRun): boolean;
  Component: ComponentType<ToolCardProps>;
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
  /** Core's own scan of the package folders and the shipped kits; absent without a host. */
  inspect?(cwd: string): Promise<ExtensionInspection>;
}

export type ExtensionEvent = Extract<GlobalHostEvent, { type: "extension-event" }>;

export interface DesktopExtensionContext {
  /** This extension's host entry, if the package has one. */
  host: HostExtensionClient;
  /**
   * Another extension's host entry, by id: how a kit depends on a kit. The
   * commands and events belong to that extension's contract, not to core, and
   * an invoke fails like any other when it is not installed.
   */
  hostExtension(extensionId: string): HostExtensionClient;
  /** Core host events this extension may react to; listeners go with deactivation. */
  events: WorkbenchEvents;
  /** The renderer's shared preferences store; extensions read and write through it instead of importing a singleton. */
  preferences: PreferencesStore;
  registerRegion(region: RegionContribution): () => void;
  registerStatusItem(item: StatusItemContribution): () => void;
  registerOverlay(overlay: OverlayContribution): () => void;
  registerPanel(panel: PanelContribution): () => void;
  /** A kind of tab this extension draws on the stage; `actions.openStageTab` opens one. */
  registerStageTab<Params extends Record<string, unknown>>(tab: StageTabContribution<Params>): () => void;
  /** A page of the Settings modal; core lends the nav entry and the frame. */
  registerSettingsPage(page: SettingsPageContribution): () => void;
  /**
   * What the host sees in the package folders and in the kits it ships: the
   * same scan Settings' inspector reads, without loading any code.
   */
  inspectPackages(cwd: string): Promise<ExtensionInspection>;
  registerComposerControl(control: ComposerControlContribution): () => void;
  /** Typed context inside the composer's input frame: chips, paste and drop handling, trigger menus. */
  registerComposerInline(inline: ComposerInlineContribution): () => void;
  /** Rows this extension shows in the transcript; `order` sorts rows sharing an anchor. */
  registerTranscriptRows(id: string, order?: number, options?: ProfileScoped): TranscriptRowsHandle;
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
    options?: ProfileScoped,
  ): () => void;
  /** Draws a batch of one tool's consecutive calls as a single card. */
  registerToolCard(card: ToolCardContribution): () => void;
}

export interface DesktopExtension {
  id: string;
  name: string;
  permissions?: readonly string[];
  granted?: boolean;
  /** The stylesheet the manifest names, as the host serves it (`url`) or as its source. */
  styles?: { url?: string; css?: string };
  activate(context: DesktopExtensionContext): void | (() => void);
}

/**
 * Puts an extension's stylesheet in the document and takes it out again. A
 * served `url` is a `<link>`, which the browser blocks rendering on until it
 * has it, so the extension's first paint is never unstyled.
 */
function mountStyles(extension: DesktopExtension): (() => void) | undefined {
  const styles = extension.styles;
  if (!styles?.url && !styles?.css) return undefined;
  const element = styles.url
    ? Object.assign(document.createElement("link"), { rel: "stylesheet", href: styles.url })
    : Object.assign(document.createElement("style"), { textContent: styles.css ?? "" });
  element.dataset.tauExtension = extension.id;
  document.head.append(element);
  return () => { element.remove(); };
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
  /** Core activated this one: it is always on and has no switch. */
  core?: boolean;
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

/** What a contribution this client does not draw hands back: nothing to dispose. */
const noContribution = (): void => undefined;
const noTranscriptRows: TranscriptRowsHandle = {
  setRows: () => undefined,
  clear: () => undefined,
  dispose: () => undefined,
};

/** Generalizes the desktop API's `invokeHostExtension` to whatever `HostClient` is active. */
export function hostExtensionBridge(client: HostClient | undefined): HostExtensionBridge {
  return {
    invoke: (extensionId, command, input) => client
      ? client.invokeHostExtension(extensionId, command, input)
      : Promise.reject(new HostUnavailableError()),
    inspect: (cwd) => client ? client.inspectExtensions(cwd) : Promise.reject(new HostUnavailableError()),
  };
}

export class ExtensionRegistry {
  private readonly hostEventListeners = new Map<string, Map<string, Set<(payload: unknown) => void>>>();

  private readonly services: { preferences: PreferencesStore };

  /** Which client is drawing. Every renderable contribution is filtered against it. */
  private readonly profile: ClientProfile;

  // `services` defaults to a private store so the many tests that build a
  // registry without a workbench keep working; real activation passes the
  // renderer's shared instance explicitly.
  private overrideDisposers: Array<() => void> = [];

  constructor(
    private readonly hostBridge: HostExtensionBridge = noHostBridge,
    services?: { preferences: PreferencesStore; profile?: ClientProfile },
  ) {
    this.services = services ?? { preferences: new PreferencesStore() };
    this.profile = services?.profile ?? "desktop";
    this.services.preferences.subscribe(() => {
      this.applyKeybindingOverrides(this.services.preferences.getSnapshot().keybindings);
    });
    this.applyKeybindingOverrides(this.services.preferences.getSnapshot().keybindings);
  }

  getProfile(): ClientProfile {
    return this.profile;
  }

  private panels = new Map<string, Owned<PanelContribution>>();
  private stageTabKinds = new Map<string, Owned<StageTabContribution>>();
  private settingsPages = new Map<string, Owned<SettingsPageContribution>>();
  private composerControls = new Map<string, Owned<ComposerControlContribution>>();
  private composerInlines = new Map<string, Owned<ComposerInlineContribution>>();
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
  /** Commands whose default chords are shadowed, and by how many live bindings. */
  private shadowedCommands = new Map<string, number>();
  private promptHooks = new Map<string, Owned<PromptHookContribution>>();
  private promptRenderers = new Map<string, Owned<PromptRendererContribution>>();
  private documentSources = new Map<string, Owned<DocumentSourceContribution>>();
  /** Values one extension published for another; core only routes them by id. */
  private extensionServices = new Map<string, ContributionOwner & { value: unknown }>();
  private serviceUsers = new Map<string, Set<ServiceUser>>();
  private renderers = new Map<string, Owned<ToolRenderer>>();
  private toolCards = new Map<string, Owned<ToolCardContribution>>();
  private options = new Map<string, ExtensionOption[]>();
  private contributionKinds = new Map<string, string[]>();
  /** Every renderable contribution an active extension offered, with the clients it claims. */
  private profiledContributions = new Map<string, ProfiledContribution[]>();
  private known = new Map<string, DesktopExtension>();
  /** Ids core activated itself; they are listed but never switched off. */
  private readonly coreIds = new Set<string>();
  private activeExtensions = new Map<string, { extension: DesktopExtension; dispose: () => void }>();
  private listeners = new Set<() => void>();
  private version = 0;
  /** The last failure per extension entry path; an entry that builds again drops out. */
  private readonly loadFailures = new Map<string, string>();
  private sortedCache = new Map<string, { version: number; value: unknown[] }>();

  /**
   * Records a renderable contribution and answers whether this client draws it.
   * A contribution the profile does not render is never registered, so its
   * component never mounts; it stays on the list Settings shows.
   */
  private scopeToProfile(owner: ContributionOwner, kind: string, id: string, label: string | undefined, scoped: ProfileScoped | undefined): boolean {
    const own = this.profiledContributions.get(owner.extensionId) ?? [];
    this.profiledContributions.set(owner.extensionId, own);
    own.push({
      ...owner,
      kind,
      id,
      ...(label === undefined ? {} : { label }),
      profiles: scoped?.profiles ?? DEFAULT_CLIENT_PROFILES,
      declared: scoped?.profiles !== undefined,
    });
    return rendersOnProfile(scoped?.profiles, this.profile);
  }

  /** Every renderable contribution the active extensions offered, drawn here or not. */
  getProfiledContributions(): ProfiledContribution[] {
    return [...this.profiledContributions.values()].flat();
  }

  /** What this client cannot draw: the "not on this client" list in Settings. */
  getUnrenderedContributions(): ProfiledContribution[] {
    return this.getProfiledContributions().filter((entry) => !rendersOnProfile(entry.profiles, this.profile));
  }

  /**
   * Activates a contribution core itself owns — the runtime commands, their
   * chords, the slash commands core answers. It carries no grant and no switch,
   * and it is on in safe mode too, where no extension is.
   */
  activateCore(extension: DesktopExtension): void {
    this.coreIds.add(extension.id);
    this.activate(extension);
  }

  /** Make an extension known without activating it, so settings can list and enable it. */
  addKnown(extension: DesktopExtension): void {
    this.known.set(extension.id, extension);
    this.changed();
  }

  activate(extension: DesktopExtension): void {
    this.deactivate(extension.id);
    this.known.set(extension.id, extension);
    const owner: ContributionOwner = { extensionId: extension.id, extensionName: extension.name };
    this.profiledContributions.delete(extension.id);
    const kinds: string[] = [];
    const disposers: Array<() => void> = [];
    // Before `activate`, so the rules are in place when the first component mounts.
    const unmountStyles = mountStyles(extension);
    if (unmountStyles) disposers.push(unmountStyles);
    const note = (kind: string) => { if (!kinds.includes(kind)) kinds.push(kind); };
    // A theme contributes only its rules; without this the Inspector shows it
    // as an extension that contributes nothing.
    if (unmountStyles) note("styles");
    const hostClient = (extensionId: string): HostExtensionClient => ({
      invoke: (command, input) => this.hostBridge.invoke(extensionId, command, input),
      onEvent: (name, listener) => {
        const byName = this.hostEventListeners.get(extensionId) ?? new Map<string, Set<(payload: unknown) => void>>();
        this.hostEventListeners.set(extensionId, byName);
        const listeners = byName.get(name) ?? new Set<(payload: unknown) => void>();
        byName.set(name, listeners);
        listeners.add(listener);
        const dispose = () => { listeners.delete(listener); };
        disposers.push(dispose);
        return dispose;
      },
    });
    const context: DesktopExtensionContext = {
      preferences: this.services.preferences,
      host: hostClient(extension.id),
      hostExtension: (extensionId) => hostClient(extensionId),
      registerPanel: (panel) => {
        if (!this.scopeToProfile(owner, "panel", panel.id, panel.label, panel)) return noContribution;
        note(panel.label.toLowerCase());
        return this.register(this.panels, panel.id, { ...panel, ...owner }, disposers);
      },
      registerStageTab: (tab) => {
        const contribution = tab as unknown as StageTabContribution;
        if (!this.scopeToProfile(owner, "stage tab", contribution.kind, contribution.kind, contribution)) return noContribution;
        note("stage tabs");
        return this.register(this.stageTabKinds, contribution.kind, { ...contribution, ...owner }, disposers);
      },
      registerSettingsPage: (page) => {
        if (!this.scopeToProfile(owner, "settings page", page.id, page.label, page)) return noContribution;
        note("settings page");
        return this.register(this.settingsPages, page.id, { ...page, ...owner }, disposers);
      },
      inspectPackages: (cwd) => this.hostBridge.inspect
        ? this.hostBridge.inspect(cwd)
        : Promise.reject(new HostUnavailableError()),
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
        if (!this.scopeToProfile(owner, `${region.placement} region`, region.id, undefined, region)) return noContribution;
        note(`${region.placement} region`);
        return this.register(this.regions, region.id, { ...region, ...owner }, disposers);
      },
      registerStatusItem: (item) => {
        if (!this.scopeToProfile(owner, "status item", item.id, undefined, item)) return noContribution;
        note("status line");
        return this.register(this.statusItems, item.id, { ...item, ...owner }, disposers);
      },
      registerOverlay: (overlay) => {
        if (!this.scopeToProfile(owner, "overlay", overlay.id, undefined, overlay)) return noContribution;
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
      registerTranscriptRows: (id, order = 0, options) => {
        if (!this.scopeToProfile(owner, "transcript rows", id, undefined, options)) return noTranscriptRows;
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
        if (!this.scopeToProfile(owner, "composer control", control.id, undefined, control)) return noContribution;
        note("composer controls");
        return this.register(this.composerControls, control.id, { ...control, ...owner }, disposers);
      },
      registerComposerInline: (inline) => {
        for (const trigger of inline.triggers ?? []) {
          if ([...trigger.char].length !== 1 || /[\s/$]/u.test(trigger.char)) {
            throw new Error(`Composer trigger "${trigger.char}" from ${extension.id} must be one character other than "/", "$" or a space`);
          }
        }
        if (!this.scopeToProfile(owner, "composer inline", inline.id, undefined, inline)) return noContribution;
        note("composer context");
        return this.register(this.composerInlines, inline.id, { ...inline, ...owner }, disposers);
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
        if (!this.scopeToProfile(owner, "sidebar", contribution.id, undefined, contribution)) return noContribution;
        note("sidebar");
        return this.register(this.sidebarContributions, contribution.id, { ...contribution, ...owner }, disposers);
      },
      registerProjectSource: (source) => {
        if (!this.scopeToProfile(owner, "project source", source.id, source.label, source)) return noContribution;
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
        const resolved: ResolvedKeybinding = { ...binding, keys: id, chord, label: formatKeyChord(chord), ...owner };
        const dropShadow = binding.replaces ? this.shadowCommand(binding.replaces) : undefined;
        // Whatever this registration turned out to be, disposing it also stops
        // shadowing the command it replaced.
        const withShadow = (dispose: () => void) => {
          if (!dropShadow) return dispose;
          const both = () => { dispose(); dropShadow(); };
          disposers.push(dropShadow);
          return both;
        };
        const existing = this.keybindings.get(id);
        // The chord is already on the command this binding replaces: take it
        // over rather than call it a conflict, and give it back on dispose.
        if (existing && binding.replaces && existing.commandId === binding.replaces) {
          this.keybindings.set(id, resolved);
          const restore = () => {
            if (this.keybindings.get(id) === resolved) this.keybindings.set(id, existing);
            this.changed();
          };
          disposers.push(restore);
          this.changed();
          return withShadow(restore);
        }
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
          return withShadow(dispose);
        }
        return withShadow(this.register(this.keybindings, id, resolved, disposers));
      },
      registerSlashCommand: (command) => {
        if (!/^[a-z][a-z0-9:-]*$/u.test(command.name)) throw new Error(`Slash command name "${command.name}" from ${extension.id} must be lowercase letters, digits, ":" or "-"`);
        note("slash commands");
        return this.register(this.slashCommands, command.name, { ...command, ...owner }, disposers);
      },
      registerPromptRenderer: (renderer) => {
        if (!this.scopeToProfile(owner, "prompt renderer", renderer.id, undefined, renderer)) return noContribution;
        note("prompt renderers");
        return this.register(this.promptRenderers, renderer.id, { ...renderer, ...owner }, disposers);
      },
      registerPromptHook: (hook) => {
        note("prompt hooks");
        return this.register(this.promptHooks, hook.id, { ...hook, ...owner }, disposers);
      },
      registerDocumentSource: (source) => {
        if (!this.scopeToProfile(owner, "document source", source.id, undefined, source)) return noContribution;
        note("documents");
        return this.register(this.documentSources, source.id, { ...source, ...owner }, disposers);
      },
      registerToolRenderer: (id, match, render, options) => {
        if (!this.scopeToProfile(owner, "tool renderer", id, undefined, options)) return noContribution;
        note("tool renderers");
        return this.register(this.renderers, id, { id, match, render, ...owner }, disposers);
      },
      registerToolCard: (card) => {
        if (!this.scopeToProfile(owner, "tool card", card.id, undefined, card)) return noContribution;
        note("tool cards");
        return this.register(this.toolCards, card.id, { ...card, ...owner }, disposers);
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
      this.profiledContributions.delete(extension.id);
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
    this.profiledContributions.delete(id);
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

  /** The kind that draws a stage tab, while the extension offering it is active. */
  getStageTabKind(kind: string): Owned<StageTabContribution> | undefined {
    return this.stageTabKinds.get(kind);
  }

  /** Every stage tab kind on offer; a tab of a kind that is gone is closed with it. */
  getStageTabKinds(): Array<Owned<StageTabContribution>> {
    return this.sorted("stage-tab-kinds", this.stageTabKinds, false);
  }

  /** Pages extensions added to Settings, in `order`. */
  getSettingsPages(): Array<Owned<SettingsPageContribution>> {
    return this.sorted("settings-pages", this.settingsPages);
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

  getComposerInlines(): Array<Owned<ComposerInlineContribution>> {
    return this.sorted("composer-inlines", this.composerInlines, false);
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

  /** Counts one shadow of a command's default chords; the returned function drops it again. */
  private shadowCommand(commandId: string): () => void {
    this.shadowedCommands.set(commandId, (this.shadowedCommands.get(commandId) ?? 0) + 1);
    this.changed();
    let dropped = false;
    return () => {
      if (dropped) return;
      dropped = true;
      const left = (this.shadowedCommands.get(commandId) ?? 1) - 1;
      if (left > 0) this.shadowedCommands.set(commandId, left);
      else this.shadowedCommands.delete(commandId);
      this.changed();
    };
  }

  /** A default chord of a command someone replaced: still registered, no longer live. */
  private isShadowed(binding: ResolvedKeybinding): boolean {
    return !binding.replaces && this.shadowedCommands.has(binding.commandId);
  }

  /** Applies user keymap overrides from config.json, replacing default chords. */
  applyKeybindingOverrides(overrides?: Record<string, string>): void {
    this.overrideDisposers.forEach((dispose) => dispose());
    this.overrideDisposers = [];
    if (!overrides) return;
    const owner: ContributionOwner = { extensionId: "user-config", extensionName: "User Config" };
    for (const [commandId, rawKeys] of Object.entries(overrides)) {
      if (!rawKeys || typeof rawKeys !== "string") continue;
      try {
        const chord = parseKeyChord(rawKeys);
        const id = normalizeKeyChord(rawKeys);
        if (!chord || !id) continue;
        const resolved: ResolvedKeybinding = {
          keys: id,
          commandId,
          replaces: commandId,
          chord,
          label: formatKeyChord(chord),
          ...owner,
        };
        const dropShadow = this.shadowCommand(commandId);
        const existing = this.keybindings.get(id);
        this.keybindings.set(id, resolved);
        this.overrideDisposers.push(() => {
          dropShadow();
          if (existing) this.keybindings.set(id, existing);
          else this.keybindings.delete(id);
        });
      } catch (err) {
        console.warn(`User keybinding override ${commandId} = ${rawKeys} is invalid:`, err);
      }
    }
    this.changed();
  }

  /** The chords that are live: a replaced default is not one of them. */
  getKeybindings(): ResolvedKeybinding[] {
    const cached = this.sortedCache.get("keybindings");
    if (cached?.version === this.version) return cached.value as ResolvedKeybinding[];
    const value = [...this.keybindings.values()].filter((binding) => !this.isShadowed(binding));
    this.sortedCache.set("keybindings", { version: this.version, value });
    return value;
  }

  getKeybindingConflicts(): readonly KeybindingConflict[] {
    return this.keybindingConflicts;
  }

  /** The display label of the chord bound to a command, if any. */
  keybindingLabel(commandId: string): string | undefined {
    for (const binding of this.getKeybindings()) if (binding.commandId === commandId) return binding.label;
    return undefined;
  }

  /** The command a keydown event should run; `modified` tells bare keys from chords with modifiers. */
  matchKeybinding(event: KeyboardEvent): { command: Owned<CommandContribution>; binding: ResolvedKeybinding; modified: boolean } | undefined {
    for (const binding of this.getKeybindings()) {
      if (!chordMatchesEvent(binding.chord, event)) continue;
      const command = this.commands.get(binding.commandId);
      return command ? { command, binding, modified: isModified(binding.chord) } : undefined;
    }
    return undefined;
  }

  /** Finds a registered command by its ID, if any. */
  getCommand(id: string): Owned<CommandContribution> | undefined {
    return this.commands.get(id);
  }

  /** Executes a command registered with `registerCommand`. */
  async executeCommand(id: string, actions: WorkbenchActions): Promise<void> {
    const command = this.commands.get(id);
    if (!command) throw new Error(`Command "${id}" is not registered.`);
    await command.run(actions);
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
      ...(this.coreIds.has(extension.id) ? { core: true } : {}),
    }));
  }

  /**
   * Asks every gate about a thread that is about to be created, in registration
   * order; the first workspace named wins. A gate that throws is reported and
   * skipped: the prompt still goes to the project the draft already has.
   */
  async prepareNewThread(event: NewThreadPromptEvent, actions: WorkbenchActions): Promise<NewThreadPromptGate | undefined> {
    for (const hook of this.promptHooks.values()) {
      if (!hook.beforeNewThread) continue;
      try {
        const result = await hook.beforeNewThread(event, actions);
        if (result?.workspace) return result;
      } catch (error) {
        actions.notify(`${hook.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return undefined;
  }

  async notifyPromptSubmitted(event: PromptSubmittedEvent, actions: WorkbenchActions): Promise<void> {
    for (const hook of this.promptHooks.values()) {
      try {
        await hook.afterPrompt?.(event, actions);
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

  /** The card that draws this tool, when one claimed it. */
  toolCardFor(tool: UiToolRun): Owned<ToolCardContribution> | undefined {
    for (const card of this.toolCards.values()) {
      if (card.match(tool)) return card;
    }
    return undefined;
  }

  toolCard(id: string): Owned<ToolCardContribution> | undefined {
    return this.toolCards.get(id);
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

  /**
   * Why an extension's module could not be built or imported the last time it
   * was tried, by the path it was tried from. The extension that was already
   * running keeps running; this is what the Inspector shows instead of it
   * silently being one version behind.
   */
  noteLoadFailure(path: string, message: string | undefined): void {
    if (message === undefined) {
      if (!this.loadFailures.delete(path)) return;
    } else {
      if (this.loadFailures.get(path) === message) return;
      this.loadFailures.set(path, message);
    }
    this.changed();
  }

  getLoadFailures(): Array<{ path: string; message: string }> {
    return [...this.loadFailures].map(([path, message]) => ({ path, message }));
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
