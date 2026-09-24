import type { ToastHandle, ToastOptions } from "../workbench/toast-store";
import { chordMatchesEvent, formatKeyChord, isMacPlatform, isModified, normalizeKeyChord, parseKeyChord, platformChordId, type KeyChord } from "./keybindings";
import { evaluateWhen, isSpecificWhen, parseWhen, whenOverlaps, type WhenNode } from "./keybinding-when";
import { domKeybindingContext } from "./keybinding-context";
import type { ComponentType, ReactNode } from "react";
import type { PanelIconComponent } from "./components/PanelIcon";
import type { HostClient } from "../workbench/host-client";
import type { HostConnectionState } from "../workbench/host-connection";
import type { HostActionResult } from "../shared/host-protocol";
import type {
  ExtensionInspection,
  GlobalHostEvent,
  HostEvent,
  HostSnapshot,
  ShellActionResult,
  ThreadBackendKind,
  UiModel,
  UiMessage,
  UiRuntimeBackend,
  UiRuntimeCatalog,
  UiProject,
  UiSession,
  UiPromptAttachment,
  UiPromptImageAttachment,
  UiSharedFile,
  UiToolOutputPreview,
  UiToolRun,
  ExtensionUiAnswer,
  ExtensionUiPrompt,
} from "../shared/contracts";
import type { DiffLoadOptions, UiFileContent, UiEditor, UiFileDiff, UiWorkspaceChanges } from "../shared/workspace-kit-types";
import type { StageTab } from "../workbench/stage";
import type { Platform, PlatformAttention } from "../workbench/platform";
import type { PlatformEnvironments } from "../workbench/environments";
import { PreferencesStore } from "./preferences";
import { errorMessage } from "../workbench/error-message";
import type { SettingScope } from "../shared/config-layers";
import { DEFAULT_CLIENT_PROFILES, rendersOnProfile, type ClientProfile, type ProfiledContribution, type ProfileScoped } from "../workbench/client-profile";

/**
 * Desktop-side extension seam. The workbench owns placement and lifecycle;
 * extensions own panels, sidebar modules, project sources, commands and tool presentation.
 */
export interface WorkbenchActions {
  /** Shows a panel wherever it sits: the dock, the drawer, or its stage tab when maximized. */
  openPanel(id: string): void;
  /** Hides a panel that is showing: closes the dock or drawer it is in, or its stage tab (API 1.11.0). */
  closePanel?(id: string): void;
  /**
   * Moves the panel in front into a stage tab beside the chat, or a maximized
   * one back to where it came from (`rightPanel.toggleMaximized`, API 1.11.0).
   */
  togglePanelMaximized?(): void;
  /** With `menu`, on the level of the command of that id that has a `submenu` (API 1.12.0). */
  openCommandPalette(options?: { menu?: string }): void;
  openSettings(page?: string): void;
  /** A new thread's draft, through the project picker; with `workspace`, in that project directly, and nothing when the window does not know it yet. */
  newSession(options?: { workspace?: string }): void;
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
  /** Hides or shows the sidebar (the thread sheet on a compact client). */
  toggleSidebar?(): void;
  notify(message: string): void;
  /**
   * A toast on the window's stack: a type icon, a title and a line, actions,
   * a copy button. It leaves after five seconds of being seen (`timeoutMs`,
   * 0 for never); an `id` already shown is replaced. New in API 1.11.0.
   */
  toast?(options: ToastOptions): ToastHandle;
  /** Opens the list of project sources extensions registered; with `source`, that source's own view (API 1.12.0). */
  openProjectSources(source?: string): void;
  /** Opens a project like the sidebar does, named by its workspace id; `inheritDraft` carries the unsent composer text into the thread that opens there. */
  openWorkspace(workspace: string, options?: { inheritDraft?: boolean }): Promise<boolean>;
  /**
   * The thread on screen: its id, model and runtime owner, the project it runs
   * in, and whether a draft is pending. For a draft there is no id yet; model,
   * runtime and project are the ones the draft will start with.
   */
  activeThread(): {
    sessionId?: string; cwd?: string; workspaceId?: string; model?: { provider: string; id: string }; backendKind?: string; draftPending: boolean;
    /** The interaction mode and the modes on offer (API 1.11.0). */
    mode?: string; modes?: readonly string[];
  } | undefined;
  /** Opens a document in the stage, as source or as its working-tree diff; `line` scrolls the source to it and marks it. */
  openFile(path: string, options?: { pin?: boolean; view?: "source" | "diff"; line?: number }): void;
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
  /** The tab the stage shows, of any kind; what a `file-tab` command acts on. */
  activeStageTab?(): StageTab | undefined;
  /** Runs a shell command the way Pi's `!` does; output goes to the thread when asked. */
  runShellAction(command: string, includeInContext: boolean): Promise<ShellActionResult>;
  /** The output the host held back from a tool of the thread on screen (`outputDeferred`). */
  toolOutput?(tool: UiToolRun): Promise<UiToolOutputPreview | undefined>;
  /** Keeps the composer from submitting until the returned release is called. */
  holdComposer(): () => void;
  /** What the user has typed into the visible composer and not sent yet. */
  composerDraft(): string;
  /** Sets what is typed into the visible composer. */
  setComposerDraft?(text: string): void;
  /** The images attached to the visible composer's draft. */
  composerImages?(): readonly UiPromptImageAttachment[];
  /** Replaces the images attached to the visible composer's draft. */
  setComposerImages?(images: readonly UiPromptImageAttachment[]): void;
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
  /**
   * A URL the page may load a workspace PDF, image, audio or video from, for
   * an `<iframe>`, `<img>`, `<audio>` or `<video>`. Nothing outside the open
   * workspace and no other type gets one; undefined on a client whose host's
   * files are not on its own machine.
   */
  shareFile?(path: string): Promise<UiSharedFile | undefined>;
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
  /**
   * The interaction mode the thread on screen runs its next turns in, or the
   * one a draft's thread starts in: `default` or one of `snapshot.modes`.
   * Resolves false when the host refused. New in API 1.11.0.
   */
  setMode?(mode: string): Promise<boolean>;
  /**
   * Sends `text` as the user's next message in the thread on screen, the way
   * the composer sends it (queued while a turn runs), and leaves the draft
   * alone. Resolves false when it was not accepted. New in API 1.11.0.
   */
  submitPrompt?(text: string): Promise<boolean>;
  /** Sends the oldest queued message of the thread on screen now, leaving the draft; false when none waits. New in API 1.11.0. */
  steerQueuedMessage?(): boolean;
  /** Opens the active instructions and system prompt modal. */
  openInstructions?(): void;
  /** Executes a command registered with `registerCommand`. */
  executeCommand?(id: string): Promise<void> | void;
  /** Copies the active thread's conversation as Markdown. */
  copyChat?(): Promise<void>;
  /** Renames the active thread / session. */
  renameThread?(title: string): Promise<boolean>;
  /** Files to the composer as a drop would (API 1.11.0); with `sessionId` they wait up to 10 s for that thread. */
  attachFiles?(files: readonly File[], options?: { sessionId?: string }): void;
  /** Cycles to the next or previous model. */
  cycleModel?(direction?: 1 | -1): Promise<boolean>;
  /**
   * Every runtime the host offers and the models a new thread of it can take,
   * from the host's cache; for the runtime of the thread on screen, the models
   * that thread offers (API 1.12.0).
   */
  runtimeModels?(): Promise<readonly RuntimeModels[]>;
  /**
   * A thread on `runtime`: the draft on screen moves to it, otherwise a new
   * draft opens in the project on screen; with `model`, it starts on that
   * model (API 1.12.0).
   */
  startThreadOn?(runtime: string, model?: UiModel): void;
  /** Cycles to the next thinking level. */
  cycleThinking?(): Promise<void>;
}

/** One runtime as `runtimeModels` answers: its catalog is absent until the host has one. */
export interface RuntimeModels {
  backend: UiRuntimeBackend;
  catalog?: UiRuntimeCatalog;
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
 * the transcript, before the thread's title, or as the status line at the
 * bottom, Pi's footer.
 */
export type RegionPlacement = "title-bar" | "thread-title" | "composer-above" | "composer-below" | "transcript-header" | "transcript-footer";

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

/**
 * Something wrong with what an extension reads — a project file it could not
 * parse, a setting it had to ignore. Settings → Inspector lists it.
 */
export interface ExtensionProblem {
  /** What the problem is about, for the user's eyes: a file path, a setting. */
  source: string;
  message: string;
  level?: "error" | "warning";
}

/** Host events the workbench forwards to extensions; the rest stays core state. */
export type WorkbenchEvent =
  | Extract<HostEvent, { type: "tool-start" | "tool-end" | "agent-status" | "user-message" | "assistant-end" | "thread-index" | "notice" | "client-count" }>
  | { type: "active-thread-changed"; sessionId?: string }
  /** The host opened another project; `from` is absent for the first one this client saw. */
  | { type: "workspace-changed"; from?: string; to: string }
  /** The window's link to the host changed state; `connected` after a drop means it is back. */
  | { type: "host-connection"; state: HostConnectionState };

export type WorkbenchEventType = WorkbenchEvent["type"];

export interface WorkbenchEvents {
  on<T extends WorkbenchEventType>(type: T, listener: (event: Extract<WorkbenchEvent, { type: T }>) => void): () => void;
}

/** A control rendered in the composer's toolbar row, beside model and thinking. */
export interface ComposerControlProps {
  snapshot?: HostSnapshot;
  actions?: WorkbenchActions;
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

/** A key pressed in the composer's text field, before core acts on it. */
export interface ComposerKeyEvent {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  /** The field's text and selection as the key went down. */
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

/** Drawn in a chip's icon slot, about the size of one character of the prompt. */
export type ComposerChipIcon = ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;

/** What an inline chip's popover draws: its details, and whatever the chip lets the user edit. */
export interface ComposerChipDetailProps {
  scope: string;
  chipId: string;
  /** Closes the popover and hands the keyboard back to the text. */
  close(): void;
}

/** One chip an inline contribution holds, drawn by core inside the prompt's text. */
export interface ComposerInlineChip {
  id: string;
  /** What the chip reads in the text; core keeps it to one line and unique within the draft. */
  label: string;
  icon?: ComposerChipIcon;
  /** The whole of it (a path, a URL), shown in the chip's popover. */
  title?: string;
  /** `busy` while it is still being prepared (an upload), `failed` when it cannot be sent. */
  state?: "busy" | "failed";
  /** Drawn in the popover a click on the chip opens. */
  Detail?: ComponentType<ComposerChipDetailProps>;
}

/**
 * Chips placed in the text instead of a strip. Core puts a token for each new
 * chip at the caret, removes the chip when the user deletes its token, draws
 * the token as a chip, and sends it as its label; the payload still goes
 * through `prepareSend`.
 */
export interface ComposerInlineChips {
  /** The draft's chips in the order they were added; `subscribe` announces changes. */
  list(scope: string): readonly ComposerInlineChip[];
  remove(scope: string, id: string): void;
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
  /** Chips drawn inside the text; `Component` then draws only what is not a chip (an error, say). */
  chips?: ComposerInlineChips;
  /** Takes files from a drop, a paste or the attach button, and answers with the ones left for core's images. */
  takeFiles?(files: readonly File[], context: ComposerInlineContext): readonly File[];
  /** Whether this draft holds something worth sending on its own; enables Send without text. Not asked of a contribution with `chips`: its chips are text. */
  hasContent?(scope: string): boolean;
  /** Called when what `hasContent` answers may have changed. */
  subscribe?(listener: () => void): () => void;
  /** Runs once per sent prompt; a throw rejects the submission and keeps the draft. */
  prepareSend?(context: ComposerInlineContext & { text: string }): ComposerSendContribution | void | Promise<ComposerSendContribution | void>;
  /** The prompt `prepareSend` contributed to was accepted or refused. */
  settleSend?(scope: string, accepted: boolean): void;
  /**
   * A key in the text field, asked before core's own handling while no menu is
   * open; `true` claims it. `setText` replaces the draft's text, caret at the end.
   */
  keyDown?(event: ComposerKeyEvent, context: ComposerInlineContext & { setText(text: string): void }): boolean;
}

/** What a composer gate is asked about, before core does it. */
export interface ComposerGateContext {
  /** `model`: a model was picked in the model picker. `prompt`: a prompt is about to go to the thread's model. */
  action: "model" | "prompt";
  /** The model picked, or the one the prompt goes to; absent when a new thread starts on its runtime's default. */
  model?: UiModel;
  /** The runtime the thread runs on, or the one a thread that does not exist yet will start on. */
  runtime?: ThreadBackendKind;
  snapshot?: HostSnapshot;
}

export interface ComposerGateProps {
  context: ComposerGateContext;
  /** Lets the action go ahead, once every later gate has let it through too. */
  proceed(): void;
  /** Stops it. A stopped model choice reopens the picker. */
  cancel(): void;
}

/**
 * Asks the user before the composer chooses a model or sends a prompt. Gates
 * run in `order`; the first whose `check` answers true draws its dialog, and
 * nothing happens until it proceeds or cancels. A `/command`, a shell command
 * and an answer to a question are not prompts and pass no gate.
 */
export interface ComposerGateContribution extends ProfileScoped {
  id: string;
  order?: number;
  /** Whether to ask; runs on every choice and send, so keep it cheap and free of side effects. */
  check(context: ComposerGateContext): boolean;
  /** The dialog, drawn over a backdrop core owns; a click outside or Escape cancels. */
  Component: ComponentType<ComposerGateProps>;
}

/** A mark on a model's row in the model picker. */
export interface ModelBadgeContribution extends ProfileScoped {
  id: string;
  order?: number;
  /** Whether a model wears the badge; runs for every listed row. */
  applies(model: UiModel, runtime: ThreadBackendKind | undefined): boolean;
  label: string;
  /** What hovering the badge says. */
  title?: string;
  tone?: "neutral" | "warning";
  /** One line under the list while any listed model wears this badge. */
  note?: string;
}

export interface PanelProps {
  active: boolean;
  /** Where the panel is drawn now (API 1.11.0); a maximized panel is on the stage. */
  placement?: PanelPlacement;
  /** Name of the extension that contributed this panel, for the panel header. */
  extensionName: string;
  actions: WorkbenchActions;
}

/** `stage` is where a maximized panel is drawn; a contribution asks for `dock` or `drawer`. */
export type PanelPlacement = "dock" | "drawer" | "stage";

export interface PanelContribution extends ProfileScoped {
  id: string;
  label: string;
  /**
   * `drawer` draws the panel below the conversation and the stage, full width,
   * instead of in the dock; one drawer panel shows at a time (API 1.11.0).
   */
  placement?: "dock" | "drawer";
  /**
   * The panel can be maximized into a stage tab (API 1.11.0). Core moves the
   * mounted panel, so its state goes with it, and it is never drawn twice.
   */
  maximizable?: boolean;
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
  /** `actions` are the workbench's, the same a panel is given. */
  render(params: Params, handle: StageTabHandle, actions: WorkbenchActions): ReactNode;
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
 * A page of Settings an extension owns. Core keeps the Settings screen, its
 * navigation and the pages that must survive safe mode; a page like this one is
 * gone with its extension.
 */
export interface SettingsPageContribution extends ProfileScoped {
  id: string;
  label: string;
  /** The nav glyph, the way a panel passes one. */
  Icon?: PanelIconComponent;
  order?: number;
  /** Words the Settings search and the palette find this page by, besides its label. */
  keywords?: readonly string[];
  /**
   * The runtime backend this page is about. Such a page gets no nav entry of
   * its own: it is that runtime's card on the Providers page, in `order`.
   */
  runtime?: ThreadBackendKind;
  /**
   * The levels this page's settings may be written to. With "project" or
   * "both" the Settings bar offers the project a change applies to, and a row
   * built with `useSetting` follows it; "host", the default, edits this machine.
   */
  scope?: SettingScope;
  Component: ComponentType<SettingsPageProps>;
}

/** One row a palette source or a palette menu answers with. */
export interface PaletteItem {
  /** Unique within its source or menu. */
  id: string;
  label: string;
  /** Context after the label: a project, a path, the line that matched. */
  detail?: string;
  /** A mark before the label; one that carries meaning names it with `aria-label` (API 1.12.0). */
  icon?: ReactNode;
  /** Words a menu's search also matches and never shows, such as a runtime drawn only as its icon (API 1.12.0). */
  keywords?: readonly string[];
  /** The value in use: the row says "Current" (API 1.12.0). */
  current?: boolean;
  /** Opens this level of the palette instead of running (API 1.12.0). */
  submenu?: PaletteMenu;
  /** What the row does; a row with a `submenu` needs none. */
  run?(actions: WorkbenchActions): void | Promise<void>;
}

/**
 * A level of the palette under a row or a command: its own rows, its own
 * search, a breadcrumb and a way back (API 1.12.0).
 */
export interface PaletteMenu {
  /** The level's name in the breadcrumb. */
  title: string;
  /** The search field's placeholder on this level. */
  placeholder?: string;
  /** What the level says when no row answers the query. */
  empty?: string;
  /**
   * The level's rows for what is typed on it ("" when nothing is). Asked when
   * the level opens and again per keystroke, with the context and signal a
   * source gets. The palette keeps the rows whose label, detail or keywords
   * hold every word of the query, best first, unless `searches` is set.
   */
  items(query: string, context: PaletteSearchContext): readonly PaletteItem[] | Promise<readonly PaletteItem[]>;
  /** `items` already answers the query: its rows are shown as they come. */
  searches?: boolean;
}

/** What the palette hands a source with every query. */
export interface PaletteSearchContext {
  actions: WorkbenchActions;
  /** The thread index as this window holds it. */
  index: { projects: readonly UiProject[]; threads: readonly UiSession[]; activeThreadId?: string };
  /** Aborted when the query changes or the palette closes; a late answer is dropped either way. */
  signal: AbortSignal;
}

/**
 * Rows the palette asks for as the user types, beside the commands: threads,
 * projects, anything a query finds. Asked only for a non-empty query.
 */
export interface PaletteSourceContribution {
  id: string;
  /** What the rows are, shown beside each: "Threads", "Projects". */
  label: string;
  order?: number;
  search(query: string, context: PaletteSearchContext): readonly PaletteItem[] | Promise<readonly PaletteItem[]>;
}

/**
 * `thread-title` is the thread title's menu; `file-tab` a button in a file tab's header, which reads the tab from `actions.activeStageTab()`;
 * `runtime-switch` an action the model picker offers with another runtime than the thread's, run with `{ runtime }`;
 * `thread-row` an action on one thread of the compact thread list (swipe or long press), run with `{ threadId }` (API 1.13.0).
 */
export type CommandSurface = "thread-title" | "file-tab" | "runtime-switch" | "thread-row";

/** What a surface hands the command it runs; the palette hands nothing. */
export interface CommandContext {
  /** On `runtime-switch`: the runtime backend kind the user pointed at. */
  runtime?: string;
  /** On `thread-row`: the thread the user acted on, which need not be the open one. */
  threadId?: string;
}

export interface CommandContribution {
  id: string;
  label: string;
  group: string;
  surfaces?: readonly CommandSurface[];
  /**
   * In the palette the row opens this level instead of running. `run` stays
   * what a chord or a surface does; `openCommandPalette({ menu: id })` opens
   * the palette on the level (API 1.12.0).
   */
  submenu?: PaletteMenu;
  /** Deletes or discards something: a surface menu draws it last, in the danger colour. */
  destructive?: boolean;
  /**
   * A glyph for surfaces that draw icons: the compact thread list's swipe tray
   * offers the first non-destructive `thread-row` command that has one (API 1.13.0).
   */
  Icon?: PanelIconComponent;
  run(actions: WorkbenchActions, context?: CommandContext): void | Promise<void>;
}

/**
 * A key chord that runs a command. Spelling follows Pi's keybindings.json
 * ("ctrl+shift+p", "escape") plus "mod" for ⌘ on macOS and Ctrl elsewhere.
 * The first binding of a chord wins; later ones are recorded as conflicts,
 * unless their `when` clauses cannot hold at the same time.
 */
export interface KeybindingContribution {
  keys: string;
  commandId: string;
  /**
   * Where the chord applies, e.g. `"terminalFocus && !stageFocus"`: context
   * names joined by `!`, `&&`, `||` and parentheses. `<name>Focus` holds while
   * the keyboard is inside an element marked `data-keybinding-context="<name>"`,
   * `<name>Open` while one is drawn. A clause that needs a context is the more
   * specific binding: it wins over one that does not, and runs before the
   * focused element sees the key. Without `when` the chord applies everywhere.
   */
  when?: string;
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

/**
 * A chord the user set for a command. Without `when` it keeps the clause of
 * the default it replaces; `"true"` makes it apply everywhere. New in API 1.12.0.
 */
export interface UserKeybinding {
  key: string;
  when?: string;
}

/**
 * The file Settings → Keybindings writes the chords the user records to. Its
 * owner binds what the file holds with `registerKeybinding` and `replaces`, as
 * before; the page only hands over a command's new chords. One at a time, the
 * last registered wins. New in API 1.12.0.
 */
export interface UserKeymapContribution {
  id: string;
  /** The file as the page names it, e.g. `~/.pi/agent/keybindings.json`. */
  label: string;
  /** Replaces a command's chords; `undefined` gives it its defaults back. Resolves once written. */
  setChords(commandId: string, chords: readonly UserKeybinding[] | undefined): Promise<void>;
  /** Gives every command its defaults back. */
  resetAll(): Promise<void>;
}

/** The owner of the chords config.json's `keybindings` sets. */
export const USER_CONFIG_KEYBINDINGS = "user-config";

/** A live binding a chord the user records would share its keys with. */
export interface KeybindingCollision {
  binding: ResolvedKeybinding;
  /** Where both clauses hold: the new chord `wins` the key, `loses` it, or they rank the same (`clash`) and one of them is dropped. */
  outcome: "wins" | "loses" | "clash";
}

export interface ResolvedKeybinding extends KeybindingContribution, ContributionOwner {
  /** Platform spelling for display, e.g. ⌘K. */
  label: string;
  chord: KeyChord;
}

/** One registration, in the order bindings are weighed. */
interface KeybindingEntry {
  binding: ResolvedKeybinding;
  ast: WhenNode | undefined;
  /** 0 a default, 1 a binding that `replaces` a command's chords, 2 an override from config.json. */
  tier: 0 | 1 | 2;
  seq: number;
}

/** An entry as it stands now: its effective clause, and whether that clause needs a context. */
interface LiveKeybinding extends KeybindingEntry {
  effective: ResolvedKeybinding;
  whenAst: WhenNode | undefined;
  specific: boolean;
}

interface KeybindingState {
  version: number;
  mac: boolean;
  live: LiveKeybinding[];
  conflicts: KeybindingConflict[];
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

/** A new thread's first prompt, offered to an extension that may start the thread itself. */
export interface NewThreadClaimEvent extends NewThreadPromptEvent {
  /** Sent with the modifier held (⌘↵ on macOS, Ctrl+↵ elsewhere). */
  alternate: boolean;
  /** The model the thread would start with; absent when the runtime picks its own. */
  model?: { provider: string; id: string };
  /** The runtime backend the thread would be created on. */
  runtime: string;
  /** Images and files attached to the prompt. */
  attachments: number;
}

export interface PromptHookContribution {
  id: string;
  /**
   * Runs first when a pending draft's first prompt leaves the composer.
   * Answering `true` takes the prompt: core creates no thread, the composer
   * empties and the draft stays open for the next one. A hook that throws is
   * reported and the prompt goes on as if nobody had claimed it.
   */
  claimNewThread?(event: NewThreadClaimEvent, actions: WorkbenchActions): Promise<boolean | void>;
  /**
   * Runs before a pending draft's first prompt leaves the composer. It may move
   * the thread to another project; a failure is reported and the draft stays
   * where it was, so the prompt is never lost to it.
   */
  beforeNewThread?(event: NewThreadPromptEvent, actions: WorkbenchActions): Promise<NewThreadPromptGate | void>;
  afterPrompt?(event: PromptSubmittedEvent, actions: WorkbenchActions): void | Promise<void>;
  /**
   * What a message sent while a turn runs becomes; the modified chord sends the
   * other. The first hook that answers wins; without one it queues as a follow-up.
   */
  streamingDelivery?(): "followUp" | "steer" | void;
}

/** A button on a transcript message's action bar, beside Copy and Fork. */
export interface MessageActionContribution extends ProfileScoped {
  id: string;
  label: string;
  Icon?: PanelIconComponent;
  /** The messages that carry it; assistant replies when absent. */
  roles?: readonly ("user" | "assistant")[];
  /** `selection` is the text selected inside this message when the button was pressed. */
  run(message: UiMessage, context: { selection?: string }, actions: WorkbenchActions): void | Promise<void>;
}

export interface MessageBlockProps {
  /** What stands between the tags. */
  body: string;
  /** False while the closing tag has not arrived yet. */
  complete: boolean;
  message: UiMessage;
  streaming: boolean;
}

/**
 * Draws a `<tag>…</tag>` block of an assistant reply in place of its text,
 * e.g. a proposed plan as a card. The tags stand on lines of their own and
 * outside code fences; the rest of the reply stays Markdown.
 */
export interface MessageBlockContribution extends ProfileScoped {
  id: string;
  tag: string;
  /** The messages whose blocks it draws; assistant replies when absent. A user message draws its blocks above the bubble. */
  roles?: readonly ("user" | "assistant")[];
  Component: ComponentType<MessageBlockProps>;
}


/**
 * A set of models a new thread's picker builds with Shift-click, kept by the
 * extension that knows what to do with more than one. Keys are `provider/id`;
 * a key appears once per time it was chosen.
 */
export interface ModelSelectionContribution {
  id: string;
  selected(): readonly string[];
  subscribe(listener: () => void): () => void;
  /** Shift-click on a row; `current` is the model the draft has now. */
  toggle(model: UiModel, current: UiModel | undefined): void;
  /** A plain pick: back to one model. */
  reset(): void;
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
  /**
   * Asks for the events the host entry emits with this `topic` until the
   * returned function is called; other clients do not receive them. Watch
   * only while the view that draws them is mounted. Optional so a stand-in
   * client in a test need not have it.
   */
  watch?(topic: string): () => void;
}

/** How the registry reaches host extensions; the desktop API is the default. */
export interface HostExtensionBridge {
  invoke(extensionId: string, command: string, input?: unknown): Promise<unknown>;
  /** Core's own scan of the package folders and the shipped kits; absent without a host. */
  inspect?(cwd: string): Promise<ExtensionInspection>;
  /** Asks the host for a topic's events; absent without a host. */
  watch?(extensionId: string, topic: string): () => void;
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
  /**
   * How this client reaches the user outside its page — a notification the OS
   * draws, a count on the app's icon — or undefined where it cannot.
   */
  readonly attention: PlatformAttention | undefined;
  /**
   * The machines this window knows and how each is doing, or undefined in a
   * client without a window process (ADR 0025). New in API 1.13.0.
   */
  readonly environments: PlatformEnvironments | undefined;
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
  /** Asks the user before a model is chosen or a prompt is sent. */
  registerComposerGate(gate: ComposerGateContribution): () => void;
  /** Marks models in the model picker, with a line explaining the mark. */
  registerModelBadge(badge: ModelBadgeContribution): () => void;
  /** Rows this extension shows in the transcript; `order` sorts rows sharing an anchor. */
  registerTranscriptRows(id: string, order?: number, options?: ProfileScoped): TranscriptRowsHandle;
  /** Replaces the transcript's waiting label for a thread while the label is set; `undefined` clears it. */
  setLiveStatus(sessionId: string, label: string | undefined): void;
  /** Publishes how threads this extension created relate to their parents; `undefined` withdraws it. */
  setThreadLineage(lineage: ThreadLineage | undefined): void;
  /** Replaces this extension's problems in Settings → Inspector; `[]` clears them. */
  setProblems(problems: readonly ExtensionProblem[]): void;
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
  /** Rows the command palette asks for as the user types, beside the commands. */
  registerPaletteSource(source: PaletteSourceContribution): () => void;
  /** Slash commands show in the composer's `/` menu next to the runtime's own. */
  registerSlashCommand(command: SlashCommandContribution): () => void;
  /** Binds a chord to a command of any extension; core dispatches window keydown. */
  registerKeybinding(binding: KeybindingContribution): () => void;
  /** Offers the file the Keybindings page writes recorded chords to. New in API 1.12.0. */
  registerUserKeymap(keymap: UserKeymapContribution): () => void;
  registerPromptHook(hook: PromptHookContribution): () => void;
  /** Lets a new thread's model picker hold several models; one extension at a time, the last one wins. */
  registerModelSelection(selection: ModelSelectionContribution): () => void;
  registerMessageAction(action: MessageActionContribution): () => void;
  /** Draws a tagged block of an assistant reply itself. New in API 1.11.0. */
  registerMessageBlock(block: MessageBlockContribution): () => void;
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
    ...(client ? { watch: (extensionId: string, topic: string) => client.watchHostTopic(extensionId, topic) } : {}),
  };
}

export class ExtensionRegistry {
  private readonly hostEventListeners = new Map<string, Map<string, Set<(payload: unknown) => void>>>();

  private readonly services: { preferences: PreferencesStore; platform?: () => Platform | undefined };

  /** Which client is drawing. Every renderable contribution is filtered against it. */
  private readonly profile: ClientProfile;

  // `services` defaults to a private store so the many tests that build a
  // registry without a workbench keep working; real activation passes the
  // renderer's shared instance explicitly.
  private overrideDisposers: Array<() => void> = [];

  constructor(
    private readonly hostBridge: HostExtensionBridge = noHostBridge,
    services?: { preferences: PreferencesStore; profile?: ClientProfile; platform?: () => Platform | undefined },
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
  private composerGates = new Map<string, Owned<ComposerGateContribution>>();
  private modelBadges = new Map<string, Owned<ModelBadgeContribution>>();
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
  private problems = new Map<string, Array<ExtensionProblem & ContributionOwner>>();
  private sidebarContributions = new Map<string, Owned<SidebarContribution>>();
  private projectSources = new Map<string, Owned<ProjectSourceContribution>>();
  private commands = new Map<string, Owned<CommandContribution>>();
  private paletteSources = new Map<string, Owned<PaletteSourceContribution>>();
  private slashCommands = new Map<string, Owned<SlashCommandContribution>>();
  private keybindingEntries: KeybindingEntry[] = [];
  private keybindingSeq = 0;
  private keybindingState: KeybindingState | undefined;
  /** Commands whose default chords are shadowed, and by how many live bindings. */
  private shadowedCommands = new Map<string, number>();
  private promptHooks = new Map<string, Owned<PromptHookContribution>>();
  private modelSelections = new Map<string, Owned<ModelSelectionContribution>>();
  private messageActions = new Map<string, Owned<MessageActionContribution>>();
  private messageBlocks = new Map<string, Owned<MessageBlockContribution>>();
  private promptRenderers = new Map<string, Owned<PromptRendererContribution>>();
  private documentSources = new Map<string, Owned<DocumentSourceContribution>>();
  private userKeymaps = new Map<string, Owned<UserKeymapContribution>>();
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
      watch: (topic) => {
        const release = this.hostBridge.watch?.(extensionId, topic) ?? (() => undefined);
        let done = false;
        const dispose = () => { if (!done) { done = true; release(); } };
        disposers.push(dispose);
        return dispose;
      },
    });
    const platform = this.services.platform;
    const context: DesktopExtensionContext = {
      preferences: this.services.preferences,
      // Read when used: the client builds its platform after the registry.
      get attention() { return platform?.()?.attention; },
      get environments() { return platform?.()?.environments; },
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
      setProblems: (problems) => {
        if (problems.length === 0 && !this.problems.has(extension.id)) return;
        if (problems.length === 0) this.problems.delete(extension.id);
        else this.problems.set(extension.id, problems.map((problem) => ({ ...problem, ...owner })));
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
      registerComposerGate: (gate) => {
        if (!this.scopeToProfile(owner, "composer gate", gate.id, undefined, gate)) return noContribution;
        note("composer gates");
        return this.register(this.composerGates, gate.id, { ...gate, ...owner }, disposers);
      },
      registerModelBadge: (badge) => {
        if (!this.scopeToProfile(owner, "model badge", badge.id, badge.label, badge)) return noContribution;
        note("model badges");
        return this.register(this.modelBadges, badge.id, { ...badge, ...owner }, disposers);
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
      registerPaletteSource: (source) => {
        note("palette sources");
        return this.register(this.paletteSources, source.id, { ...source, ...owner }, disposers);
      },
      registerKeybinding: (binding) => {
        const chord = parseKeyChord(binding.keys);
        const id = normalizeKeyChord(binding.keys);
        if (!chord || !id) throw new Error(`Keybinding "${binding.keys}" from ${extension.id} is not a key chord`);
        const when = binding.when?.trim() || undefined;
        const ast = when ? parseWhen(when) : undefined;
        if (when && !ast) throw new Error(`Keybinding "${binding.keys}" from ${extension.id} has a when clause Tau cannot read: ${when}`);
        note("keybindings");
        const { when: _when, ...rest } = binding;
        const resolved: ResolvedKeybinding = { ...rest, ...(when ? { when } : {}), keys: id, chord, label: formatKeyChord(chord), ...owner };
        const dropShadow = binding.replaces ? this.shadowCommand(binding.replaces) : undefined;
        const entry = this.addKeybinding(resolved, ast, binding.replaces ? 1 : 0);
        const conflict = this.resolveKeybindings().conflicts.find((candidate) => candidate.commandId === binding.commandId && candidate.keys === id && candidate.extensionId === extension.id);
        if (conflict) console.warn(`Keybinding ${id} from ${extension.id} (${binding.commandId}) is already bound to ${conflict.boundTo.commandId} by ${conflict.boundTo.extensionId}; keeping the first.`);
        let disposed = false;
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          this.removeKeybinding(entry);
          dropShadow?.();
        };
        disposers.push(dispose);
        return dispose;
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
      registerModelSelection: (selection) => {
        note("model selection");
        return this.register(this.modelSelections, selection.id, { ...selection, ...owner }, disposers);
      },
      registerMessageAction: (action) => {
        if (!this.scopeToProfile(owner, "message action", action.id, action.label, action)) return noContribution;
        note("message actions");
        return this.register(this.messageActions, action.id, { ...action, ...owner }, disposers);
      },
      registerMessageBlock: (block) => {
        if (!this.scopeToProfile(owner, "message block", block.id, undefined, block)) return noContribution;
        note("message blocks");
        return this.register(this.messageBlocks, block.id, { ...block, ...owner }, disposers);
      },
      registerUserKeymap: (keymap) => {
        note("user keymap");
        return this.register(this.userKeymaps, keymap.id, { ...keymap, ...owner }, disposers);
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
    this.problems.delete(id);
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

  /** What the active extensions reported as wrong, in activation order. */
  getProblems(): Array<ExtensionProblem & ContributionOwner> {
    return [...this.problems.values()].flat();
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

  getComposerGates(): Array<Owned<ComposerGateContribution>> {
    return this.sorted("composer-gates", this.composerGates);
  }

  getModelBadges(): Array<Owned<ModelBadgeContribution>> {
    return this.sorted("model-badges", this.modelBadges);
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

  /** The palette's sources, in `order`. */
  getPaletteSources(): Array<Owned<PaletteSourceContribution>> {
    return this.sorted("palette-sources", this.paletteSources);
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
    const owner: ContributionOwner = { extensionId: USER_CONFIG_KEYBINDINGS, extensionName: "User Config" };
    for (const [commandId, rawKeys] of Object.entries(overrides)) {
      if (!rawKeys || typeof rawKeys !== "string") continue;
      const chord = parseKeyChord(rawKeys);
      const id = normalizeKeyChord(rawKeys);
      if (!chord || !id) {
        console.warn(`User keybinding override ${commandId} = ${rawKeys} is not a key chord`);
        continue;
      }
      const dropShadow = this.shadowCommand(commandId);
      const entry = this.addKeybinding({ keys: id, commandId, replaces: commandId, chord, label: formatKeyChord(chord), ...owner }, undefined, 2);
      this.overrideDisposers.push(() => { this.removeKeybinding(entry); dropShadow(); });
    }
    this.changed();
  }

  private addKeybinding(binding: ResolvedKeybinding, ast: WhenNode | undefined, tier: KeybindingEntry["tier"]): KeybindingEntry {
    const entry: KeybindingEntry = { binding, ast, tier, seq: this.keybindingSeq++ };
    this.keybindingEntries.push(entry);
    this.changed();
    return entry;
  }

  private removeKeybinding(entry: KeybindingEntry): void {
    const index = this.keybindingEntries.indexOf(entry);
    if (index < 0) return;
    this.keybindingEntries.splice(index, 1);
    this.changed();
  }

  /**
   * Which bindings are live and which lost their chord. A replaced default is
   * not live. A binding that replaces a command without a `when` of its own
   * takes the clause of that command's first default, so a rebound key keeps
   * its context. Two live bindings collide when they press the same keys on this
   * platform (`mod+p` is `ctrl+p` off macOS), share a tier and
   * specificity, run different commands and their clauses can hold together;
   * the earlier one keeps the chord.
   */
  private resolveKeybindings(mac = isMacPlatform()): KeybindingState {
    if (this.keybindingState?.version === this.version && this.keybindingState.mac === mac) return this.keybindingState;
    const defaults = new Map<string, KeybindingEntry>();
    for (const entry of this.keybindingEntries) {
      if (entry.tier === 0 && !defaults.has(entry.binding.commandId)) defaults.set(entry.binding.commandId, entry);
    }
    const ordered = this.keybindingEntries
      .filter((entry) => !this.isShadowed(entry.binding))
      .sort((a, b) => b.tier - a.tier || a.seq - b.seq);
    const live: LiveKeybinding[] = [];
    const conflicts: KeybindingConflict[] = [];
    for (const entry of ordered) {
      const inherited = !entry.binding.when && entry.binding.replaces ? defaults.get(entry.binding.replaces) : undefined;
      const whenAst = entry.ast ?? inherited?.ast;
      const effective = inherited?.binding.when ? { ...entry.binding, when: inherited.binding.when } : entry.binding;
      const candidate: LiveKeybinding = { ...entry, effective, whenAst, specific: isSpecificWhen(whenAst) };
      const chord = platformChordId(entry.binding.chord, mac);
      const holder = live.find((other) => platformChordId(other.binding.chord, mac) === chord
        && other.tier === entry.tier
        && other.specific === candidate.specific
        && other.binding.commandId !== entry.binding.commandId
        && whenOverlaps(other.whenAst, whenAst));
      if (holder) {
        conflicts.push({ keys: entry.binding.keys, commandId: entry.binding.commandId, extensionId: entry.binding.extensionId, boundTo: { commandId: holder.binding.commandId, extensionId: holder.binding.extensionId } });
        continue;
      }
      live.push(candidate);
    }
    live.sort((a, b) => a.seq - b.seq);
    this.keybindingState = { version: this.version, mac, live, conflicts };
    return this.keybindingState;
  }

  /** The chords that are live: a replaced default or a binding that lost its chord is not one of them. */
  getKeybindings(): ResolvedKeybinding[] {
    const cached = this.sortedCache.get("keybindings");
    if (cached?.version === this.version) return cached.value as ResolvedKeybinding[];
    const value = this.resolveKeybindings().live.map((entry) => entry.effective);
    this.sortedCache.set("keybindings", { version: this.version, value });
    return value;
  }

  /** Chords that lost to an earlier binding; `mac` asks about the other platform, where `mod` is another key. */
  getKeybindingConflicts(mac?: boolean): readonly KeybindingConflict[] {
    return this.resolveKeybindings(mac).conflicts;
  }

  /** A command's default chords, live or replaced, in the order they were registered. */
  getDefaultKeybindings(commandId: string): ResolvedKeybinding[] {
    return this.keybindingEntries.filter((entry) => entry.tier === 0 && entry.binding.commandId === commandId).map((entry) => entry.binding);
  }

  /** Where recorded chords are written, from the extension that registered last. */
  getUserKeymap(): Owned<UserKeymapContribution> | undefined {
    return [...this.userKeymaps.values()].at(-1);
  }

  /**
   * The live bindings of other commands a chord the user sets for `commandId`
   * would press the same keys as on this platform (or `mac`), where both
   * clauses can hold. The chord ranks as a replacing binding and, without a
   * `when`, takes the clause of the command's first default.
   */
  findKeybindingCollisions(candidate: UserKeybinding & { commandId: string }, mac = isMacPlatform()): KeybindingCollision[] {
    const chord = parseKeyChord(candidate.key);
    const when = candidate.when?.trim() || undefined;
    const ast = when ? parseWhen(when) : this.keybindingEntries.find((entry) => entry.tier === 0 && entry.binding.commandId === candidate.commandId)?.ast;
    if (!chord || (when && !ast)) return [];
    const specific = isSpecificWhen(ast);
    const keys = platformChordId(chord, mac);
    return this.resolveKeybindings(mac).live
      .filter((other) => other.binding.commandId !== candidate.commandId && platformChordId(other.binding.chord, mac) === keys && whenOverlaps(other.whenAst, ast))
      .map((other) => ({
        binding: other.effective,
        outcome: other.tier !== 1 ? (other.tier < 1 ? "wins" : "loses") : other.specific === specific ? "clash" : specific ? "wins" : "loses",
      }));
  }

  /** The display label of the chord bound to a command, if any. */
  keybindingLabel(commandId: string): string | undefined {
    for (const binding of this.getKeybindings()) if (binding.commandId === commandId) return binding.label;
    return undefined;
  }

  /**
   * The command a keydown event should run in `context` (read from the page by
   * default). Of the bindings whose chord and clause match, an override from
   * config.json beats a replacing binding beats a default; within that, a
   * clause that needs a context beats one that does not, then the first
   * registered. `modified` tells bare keys from chords with modifiers;
   * `specific` says the winner's clause needs a context, so it runs before
   * the focused element sees the key.
   */
  matchKeybinding(event: KeyboardEvent, context: (name: string) => boolean = domKeybindingContext()): { command: Owned<CommandContribution>; binding: ResolvedKeybinding; modified: boolean; specific: boolean } | undefined {
    let best: LiveKeybinding | undefined;
    for (const entry of this.resolveKeybindings().live) {
      if (!chordMatchesEvent(entry.binding.chord, event)) continue;
      if (entry.whenAst && !evaluateWhen(entry.whenAst, context)) continue;
      if (!best || entry.tier > best.tier || (entry.tier === best.tier && entry.specific && !best.specific)) best = entry;
    }
    if (!best) return undefined;
    const command = this.commands.get(best.binding.commandId);
    return command ? { command, binding: best.effective, modified: isModified(best.binding.chord), specific: best.specific } : undefined;
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
        actions.notify(`${hook.id}: ${errorMessage(error)}`);
      }
    }
    return undefined;
  }

  /**
   * Offers a new thread's first prompt to every hook that may start it itself,
   * in registration order; the first that answers `true` has taken it.
   */
  async claimNewThread(event: NewThreadClaimEvent, actions: WorkbenchActions): Promise<boolean> {
    for (const hook of this.promptHooks.values()) {
      if (!hook.claimNewThread) continue;
      try {
        if (await hook.claimNewThread(event, actions)) return true;
      } catch (error) {
        actions.notify(`${hook.id}: ${errorMessage(error)}`);
      }
    }
    return false;
  }

  /** The model set a new thread's picker builds, from the extension that registered last. */
  getModelSelection(): Owned<ModelSelectionContribution> | undefined {
    return [...this.modelSelections.values()].at(-1);
  }

  streamingDelivery(): "followUp" | "steer" | undefined {
    for (const hook of this.promptHooks.values()) {
      const delivery = hook.streamingDelivery?.();
      if (delivery) return delivery;
    }
    return undefined;
  }

  getMessageActions(): Array<Owned<MessageActionContribution>> {
    return this.sorted("message-actions", this.messageActions, false);
  }

  getMessageBlocks(): Array<Owned<MessageBlockContribution>> {
    return this.sorted("message-blocks", this.messageBlocks, false);
  }

  async notifyPromptSubmitted(event: PromptSubmittedEvent, actions: WorkbenchActions): Promise<void> {
    for (const hook of this.promptHooks.values()) {
      try {
        await hook.afterPrompt?.(event, actions);
      } catch (error) {
        actions.notify(`${hook.id}: ${errorMessage(error)}`);
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
