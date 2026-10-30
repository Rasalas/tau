/** Public desktop extension contracts. Imports here are types only; runtime registration lives separately. */
import type { ComponentType, ReactNode } from "react";
import type { SettingScope } from "../shared/config-layers";
import type {
  ExtensionInspection,
  ExtensionUiAnswer,
  ExtensionUiPrompt,
  GlobalHostEvent,
  HostEvent,
  HostSnapshot,
  ShellActionResult,
  SubmissionResult,
  ThreadBackendKind,
  UiMessage,
  UiModel,
  UiProject,
  UiPromptAttachment,
  UiPromptImageAttachment,
  UiRuntimeBackend,
  UiRuntimeCatalog,
  UiSession,
  UiSharedFile,
  UiSkillDraft,
  UiToolOutputPreview,
  UiToolRun,
} from "../shared/contracts";
import type { HostActionResult } from "../shared/host-protocol";
import type { DiffLoadOptions, UiEditor, UiFileContent, UiFileDiff, UiWorkspaceChanges } from "../shared/workspace-kit-types";
import type { ProfileScoped } from "../workbench/client-profile";
import type { PlatformEnvironments } from "../workbench/environments";
import type { HostConnectionState } from "../workbench/host-connection";
import type { PlatformAttention } from "../workbench/platform";
import type { StageTab } from "../workbench/stage";
import type { ThreadRowMark } from "../workbench/thread-row-status";
import type { ToastHandle, ToastOptions } from "../workbench/toast-store";
import type { MenuSection } from "./components/Menu";
import type { PanelIconComponent } from "./components/PanelIcon";
import type { CustomizablePart, CustomizationLayer } from "./customization";
import type { KeybindingContribution, UserKeymapContribution } from "./extension-keybindings";
import type { PreferencesStore } from "./preferences";
import type { SettingsNavGroup, SettingsNavGroupAlias } from "./settings/settings-nav";
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
  /** Leaves Settings for what it covered (API 1.62.0). */
  closeSettings?(): void;
  /**
   * A new thread's draft in the project on screen, else where the host last worked, else through the picker (API 1.25.0).
   * With `workspace`, in that project, and nothing when the window does not know it yet; with `pick`, through the picker.
   */
  newSession(options?: { workspace?: string; pick?: boolean; project?: UiProject }): void;
  switchSession(path: string): Promise<boolean>;
  /** Makes a new thread's draft from the list (`threadStore.getDrafts()`) the one on screen (API 1.21.0). */
  openDraft?(draftId: string): void;
  /** Throws a draft away; the draft on screen closes onto the thread the host has open (API 1.21.0). */
  discardDraft?(draftId: string): void;
  settleActiveThread(): void;
  abort(): void;
  /** The thread on screen's native goal (API 1.52.0); rejects where its runtime keeps none. `set` needs the objective. */
  threadGoal?(action: "set" | "pause" | "resume" | "clear" | "dismiss", objective?: string): Promise<void>;
  /** Stops a background task of the thread on screen, or all of them without an id (API 1.58.0). */
  stopBackground?(taskId?: string): Promise<void>;
  /** Builds Tau, reloads Pi resources and desktop extensions, then restarts the app when required. */
  restartAgentSession?(): Promise<void>;
  reloadWorkbench(): Promise<boolean>;
  /** Creates and opens the editable source tree used by an installed Tau. */
  openWorkbenchSource(): Promise<boolean>;
  /** Pi's /tree and /fork: the session tree of the active thread, to move in or fork from. */
  openThreadTree(mode?: "navigate" | "fork"): void;
  /** Pi's /clone: a new thread continuing from the active thread's current point; a fork prompt asks first unless `ask` is false. */
  duplicateThread(options?: { ask?: boolean }): Promise<boolean>;
  /**
   * Forks the thread on screen through `message`: a new thread with the conversation up to it (API 1.39.0).
   * With `workspace`, the fork runs in that project; false when nothing was forked.
   * `prompt` starts a task there; `stayInSource` keeps this thread on screen.
   * A rejected task stays as the fork's draft and still returns true.
   */
  forkFrom?(message: Pick<UiMessage, "sourceEntryId">, options?: { workspace?: string; prompt?: string; stayInSource?: boolean; expectedSessionId?: string }): Promise<boolean>;
  /**
   * A fork through `entryId` the way the user starts one: the fork prompt asks first, with `prompt` as the task it
   * offers; without a prompt registered the fork starts at once with that task and stays in the background.
   * True once a question or a fork exists (API 1.59.0).
   */
  askFork?(request: ForkRequest & { entryId: string }): Promise<boolean>;
  focusComposer(seed?: string): void;
  focusTranscript(): void;
  /**
   * Scrolls the transcript to a message of the thread on screen and marks it, loading
   * older turns first when it is not among them. False when the thread has no such message.
   */
  revealMessage?(messageId: string): Promise<boolean>;
  /**
   * Opens the find bar over the transcript of the thread on screen, or takes the keyboard back
   * into it when it is open; nothing happens without a transcript (API 1.61.0).
   */
  findInThread?(): void;
  focusStage(): void;
  toggleDock(): void;
  /** Hides or shows the sidebar (the thread sheet on a compact client). */
  toggleSidebar?(): void;
  /** Collapses the conversation to its spine beside the stage, or opens it again (design 1b). */
  toggleSpine?(): void;
  /**
   * A one-line toast. `level` is `info` by default; a failure reports as `error`,
   * which stays until dismissed and offers Copy (API 1.60.0).
   */
  notify(message: string, level?: "info" | "warning" | "error"): void;
  /**
   * A toast on the window's stack: a type icon, a title and a line, actions,
   * a copy button. It leaves after five seconds of being seen (`timeoutMs`,
   * 0 for never; an `error` stays by default, API 1.60.0); an `id` already
   * shown is replaced. New in API 1.11.0.
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
    /** True while a page, Settings, an overlay or a phone's thread list covers the thread (API 1.20.0). */
    covered?: boolean;
  } | undefined;
  /**
   * Every thread of the list core draws itself (a compact client's), top to
   * bottom, settled ones where they would stand unsettled; undefined where a
   * kit's rail is the list (API 1.20.0).
   */
  threadListOrder?(): readonly string[] | undefined;
  /** On a phone, where the thread list is a screen of its own, shows it and answers true; false elsewhere (API 1.64.0). */
  showThreadList?(): boolean;
  /** Opens a document in the stage, as source or as its working-tree diff; `line` scrolls the source to it and marks it. */
  /** `trace`: the agent opened it; it joins the stage's end without coming to the front (design 1a). */
  openFile(path: string, options?: { pin?: boolean; view?: "source" | "diff"; line?: number; trace?: boolean }): void;
  /**
   * Opens a thread in the stage as a read-only tab, leaving the active thread
   * alone. `machine` (a host id, or a machine's unique name) reads a thread of
   * another machine this window knows, live over the window's connection
   * there, with "Open on <machine>" to move the window to it (API 1.15.0).
   */
  openThread(sessionId: string, options?: { pin?: boolean; machine?: string }): void;
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
  /**
   * Runs a shell command in the project of the thread on screen, the way Pi's
   * `!` does; its output joins the thread when `includeInContext`. It asks no
   * permission: permissions gate the host half, and a desktop half acts in the
   * window with what the user can do there, so approving the package is what
   * trusts it this far. A device paired Read only is refused it.
   */
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
  /** Brings back the tab closed last on this stage, or the closed tab `id` names (API 1.52.0); false when there is none. */
  reopenStageTab?(id?: string): boolean;
  /** Moves forward or backward through stage tabs. */
  cycleStageTab?(direction: 1 | -1): void;
  /** Shows a stage tab beside the active one; without an id, splits off the active tab or joins the panes again. */
  splitStage?(tabId?: string): void;
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
  /**
   * Shows a view `registerConversationView` added in place of the thread's
   * transcript and composer; the header, stage and panels stay. Another
   * thread on screen closes it (API 1.57.0).
   */
  openConversationView?(id: string, params?: Record<string, unknown>): void;
  /** Back to the thread's own transcript (API 1.57.0). */
  closeConversationView?(): void;
  /** One step back or forward over the threads and views this window showed, as a browser's history (new after API 1.59.0). */
  navigateHistory?(direction: -1 | 1): Promise<boolean>;
  /** Opens a page `registerPage` added, beside the sidebar; `params` is what it opens on. */
  openPage?(id: string, params?: Record<string, unknown>): void;
  /** Closes the open page, back to the thread. */
  closePage?(): void;
  /** Manually compact the active thread's context window. Resolves `false` when it did not (API 1.53.0); the user was told why. */
  compactContext?(): Promise<boolean | void>;
  /** Queues a captured prompt on this thread, compacts, then sends it automatically. */
  compactAndSend?(sessionId: string, prompt: { text: string; attachments: UiPromptAttachment[]; skillDraft?: UiSkillDraft }): Promise<boolean>;
  /** Opens the model picker modal for selecting a model. */
  openModelPicker?(): void;
  /** Sets the model for the active thread or pending new thread. Accepts (provider, id) or query string. */
  setModel?(provider: string, id?: string): Promise<boolean> | void;
  /** Sets the thinking level for the composer on screen, including a new thread's draft (API 1.72.0). */
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
  /** Cycles thinking forward by default; API 1.72.0 adds direction and bounded steps that stop at either end. */
  cycleThinking?(direction?: 1 | -1, bounded?: boolean): Promise<void>;
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
  /** A private thread workspace offered directly by the new-thread picker. */
  createThreadWorkspace?(): Promise<UiProject>;
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
 * bottom, Pi's footer. `look-in` sits under the header of a tab that shows a
 * thread of another machine (API 1.15.0); its props carry `lookIn`. `title-bar`
 * is the thread header's end, beside the tools, and stays mounted while
 * the conversation is folded (API 1.27.0: the window-wide bar is gone);
 * `stage-bar` sits above the conversation, beside the stage collapse control
 * (introduced in API 1.27.0). `thread-details` adds items to the thread header's sub-line,
 * before the branch; `thread-branch` draws the branch there instead of core's
 * plain label (both API 1.27.0). `draft-actions` adds pills beside the
 * project under a new thread's heading, each opening its own popover.
 * `thread-list-head` tops a phone's or tablet's thread list, under its header
 * (API 1.30.0). `thread-list-title` adds compact controls to a phone's top bar, before Settings;
 * a tablet's sidebar has a foot for them (`PageContribution.Summary`). `turn-divider` sits in
 * the prompt's metadata without a numbered separator; its props carry `turn` (API 1.39.0).
 * `workspace-summary` groups workspace context above the stage; `workspace-preview`
 * reserves space beneath it for extension-owned live frames without covering chat.
 * `spine` fills the narrow column the conversation collapses to (design 1b), under the title.
 */
/**
 * A place a kit offers in its own surface for others to fill, `<kit id>/<name>`
 * (`tau.usage/page-end`); the kit draws it with `Slot` (API 1.62.0).
 */
export type SlotPlacement = `${string}/${string}`;

export type RegionPlacement = "workspace-summary" | "workspace-preview" | "title-bar" | "thread-title" | "thread-details" | "thread-branch" | "draft-actions" | "stage-bar" | "composer-above" | "composer-controls" | "composer-below" | "transcript-header" | "transcript-footer" | "look-in" | "thread-list-head" | "thread-list-title" | "turn-divider" | "spine";

/** Where a thread of a list source runs: its mark and name on the row's project line. */
export interface ThreadListPlace {
  name: string;
  icon: ReactNode;
}

/**
 * A thread of somewhere else that the compact thread list shows among this
 * host's own, by time (API 1.30.0): another machine's. It opens with `open`;
 * it cannot be pinned, settled or acted on from here.
 */
export interface ThreadListEntry {
  /** Unique in the list, and never the id of a thread of this host. */
  key: string;
  session: UiSession;
  projectIcon?: string;
  running?: boolean;
  /** Waits for an answer there (API 1.35.0). */
  waiting?: boolean;
  /** Work there wakes it again, such as a background task or a watched pull request (API 1.64.0). */
  background?: boolean;
  /** Set while `open` is under way. */
  opening?: boolean;
  /** On the settled shelf rather than among the active threads. */
  settled?: boolean;
  machine: ThreadListPlace;
  /** Why it cannot be reached now; the row is dimmed and says so, and still opens. */
  unavailable?: string;
  open(actions: WorkbenchActions): void;
}

/** A kit's threads for the compact list; `threads()` keeps its identity until `subscribe`'s listener runs. */
export interface ThreadListSource {
  id: string;
  subscribe(listener: () => void): () => void;
  threads(): readonly ThreadListEntry[];
  /** Where this host's own threads run, named on their rows while entries of elsewhere show. */
  here?(): ThreadListPlace | undefined;
}

/** A kit's marks on a compact thread list's rows, drawn beside the branch as the desktop rail's accessories are (new after API 1.59.0). */
export interface ThreadListAccessoryContribution {
  id: string;
  /** `settled`: the row is on the settled shelf. Draws nothing when it has nothing to say. */
  Component: ComponentType<{ session: UiSession; settled: boolean }>;
}

/**
 * A kit's say over the compact list's sections (API 1.64.0). While any layout
 * answers `working()` true, working and monitoring threads fold into a Working
 * group, and the active threads go newest first by when each came back.
 */
export interface ThreadListLayout {
  id: string;
  subscribe(listener: () => void): () => void;
  working(): boolean;
}

/** The thread of another machine a look-in tab shows, for a `look-in` region (API 1.15.0). */
export interface LookInRegionContext {
  /** The machine's host id; `environments.readExtension` takes it. */
  machine: string;
  machineName: string;
  sessionId: string;
  /** The window reaches the machine now. */
  connected: boolean;
}

/** One turn of the thread on screen, for a `turn-divider` region (API 1.39.0). */
export interface TranscriptTurn {
  /** 1-based among the turns the transcript has loaded. */
  number: number;
  /** Its prompt, then everything that answered it. */
  messages: readonly UiMessage[];
  /** The newest turn, which may still run. */
  last: boolean;
}

export interface RegionProps {
  /** In `stage-bar`, controls the in-flow summary when the layout has room for it. */
  workspaceSummary?: { shown: boolean; toggle(): void };
  /** Core currently reserves an in-flow workspace preview beside the conversation. */
  workspacePreviewAvailable?: boolean;
  snapshot?: HostSnapshot;
  actions: WorkbenchActions;
  /** Set only in the `look-in` placement. */
  lookIn?: LookInRegionContext;
  /** Set only in the `turn-divider` placement. */
  turn?: TranscriptTurn;
}

export interface RegionContribution extends ProfileScoped {
  id: string;
  placement: RegionPlacement | SlotPlacement;
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

export interface ConversationViewProps {
  actions: WorkbenchActions;
  /** The thread the view was opened on. */
  snapshot: HostSnapshot | undefined;
  params: Readonly<Record<string, unknown>>;
  /** Back to the thread's transcript. */
  onClose(): void;
  /** The thread head names the view through its `Title`, so the view needs no title of its own (new after API 1.59.0). */
  headed?: boolean;
}

/** A view in the conversation column, such as a native subagent's run (API 1.57.0). */
export interface ConversationViewContribution extends ProfileScoped {
  id: string;
  Component: ComponentType<ConversationViewProps>;
  /** The view's name in the thread head, after the thread's as its parent (new after API 1.59.0). */
  Title?: ComponentType<ConversationViewProps>;
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
  /** This client's composer prompt was accepted, including queueing and steering. Contains no prompt or thread data. API 1.55.0. */
  | { type: "prompt-accepted" }
  /** The host opened another project; `from` is absent for the first one this client saw. */
  | { type: "workspace-changed"; from?: string; to: string }
  /** The window's link to the host changed state; `connected` after a drop means it is back. */
  | { type: "host-connection"; state: HostConnectionState }
  /** The host sent a model catalog; `providers` are its models' providers, sorted (API 1.29.0). */
  | { type: "models-changed"; providers: readonly string[] };

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
  /**
   * `toolbar` adds optional controls to the overflow menu; `lead` before the model chip
   * (API 1.27.0: a new thread's machine); `menu` is drawn inside the
   * composer's "…" menu, built from `ComposerMenuSection`/`ComposerMenuItem`;
   * `status` after the thinking level, the first control a narrow row drops
   * (API 1.68.0: Access Kit's level); `footer` spans the row below the editor.
   */
  placement?: "toolbar" | "lead" | "menu" | "status" | "footer";
  /** Shortcut ids (`data-composer-shortcut`) that open a `menu` control: the menu's trigger answers to them. */
  shortcuts?: readonly string[];
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
  /** API 1.71.0: a typed drag payload. Core offers matching drops; `take` validates it and returns true to claim it. */
  drop?: { mimeType: string; take(value: string, context: ComposerInlineContext): boolean };
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
  /**
   * The action is in a new thread's draft (new in API 1.14.0). Its `snapshot`
   * names the draft's project, model and runtime, but still carries the
   * messages of the thread it was opened from, so ask this, not `messages`.
   */
  newThread?: boolean;
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

/** Fast for the composer's thread, as one kit knows it. */
export interface ComposerSpeedState {
  fast: boolean;
  /** False where the thread's model or runtime offers no faster tier; `reason` says why. */
  available: boolean;
  reason?: string;
  /** What Fast does or costs, under its name. */
  detail?: string;
}

/**
 * A runtime's faster tier, drawn by core in the thinking chip (⚡) and its
 * menu (K142). `read` answers from what the kit holds and must return the same
 * object until it changes; it says `undefined` for a thread it has nothing to
 * do with, and calls `subscribe`'s listener once it knows more.
 */
export interface ComposerSpeedContribution extends ProfileScoped {
  id: string;
  order?: number;
  read(snapshot: HostSnapshot | undefined): ComposerSpeedState | undefined;
  subscribe(listener: () => void): () => void;
  set(fast: boolean, snapshot: HostSnapshot | undefined): void | Promise<void>;
}

/** An entry in the menu beside a send mode's button. */
export interface ComposerSendOption {
  id: string;
  label: string;
  /** A second line: what the choice costs or does. */
  detail?: string;
  /** Runs when picked, before the prompt goes. */
  run?(): void;
  /** Sends the draft as usual, without `beforeSend`; otherwise the pick sends nothing. */
  send?: boolean;
}

/** What the send button does for a thread instead of sending at once (API 1.53.0). */
export interface ComposerSendMode {
  /** The button's words, drawn in place of the arrow: "Compact and send". */
  label: string;
  /** What hovering the button says. */
  title?: string;
  /** The button's words while `beforeSend` runs. */
  busyLabel?: string;
  /** Drawn before the words, and alone when the composer's footer has no room for them. */
  Icon?: PanelIconComponent;
  /** Runs once the prompt has passed every gate; the prompt goes when it resolves. A rejection keeps the draft. */
  beforeSend(actions: WorkbenchActions | undefined): Promise<void>;
  /** Owns submission of the captured prompt, including any prerequisite work. */
  submit?(actions: WorkbenchActions | undefined, prompt: { text: string; attachments: UiPromptAttachment[]; skillDraft?: UiSkillDraft }): Promise<SubmissionResult>;
  /** The menu beside the button. */
  options?: readonly ComposerSendOption[];
}

/**
 * Changes the composer's send button for a thread (API 1.53.0): Enter and the
 * button run `beforeSend` first. `read` answers like a speed's: the same object
 * until something changes, `undefined` to send as usual, and `subscribe`'s
 * listener once the answer may differ. Core asks only for a thread's own
 * composer at rest, never while it streams, answers a question or drafts a new thread.
 */
export interface ComposerSendModeContribution extends ProfileScoped {
  id: string;
  order?: number;
  read(snapshot: HostSnapshot): ComposerSendMode | undefined;
  subscribe(listener: () => void): () => void;
}

/** What a planner's tab in the Plan sheet gets (API 1.65.0). */
export interface ComposerPlannerProps {
  /** The draft's text, with its chips as plain text, and how many files wait beside it. */
  draft: { text: string; attachments: number };
  /** The thread the composer writes to. */
  snapshot: HostSnapshot;
  actions: WorkbenchActions | undefined;
  /** Saved: the composer clears its draft, closes the sheet and shows `summary` ("Every Monday at 09:00"). */
  onPlanned(summary: string): void;
  onCancel(): void;
}

/**
 * Another way to plan the composer's draft, beside sending it once into this
 * thread later: the Plan sheet shows it as a tab (API 1.65.0). The tab draws
 * everything below the tabs, its footer included; `.plan-sheet-body` and
 * `.plan-sheet-footer` give it the sheet's spacing.
 */
export interface ComposerPlannerContribution extends ProfileScoped {
  id: string;
  /** The tab's name: "Repeat". */
  label: string;
  order?: number;
  Component: ComponentType<ComposerPlannerProps>;
}

/** A mark on a model's row in the model picker, and optionally words after the highlighted row's facts. */
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
  /**
   * Added after the highlighted row's facts, for the way that row takes,
   * whether or not the model wears the badge: what an account has left, say.
   * It draws nothing when it has nothing to say, and must not throw.
   */
  WayLine?: ComponentType<{ model: UiModel; runtime: ThreadBackendKind }>;
}

export interface PanelProps {
  active: boolean;
  /** Where the panel is drawn now (API 1.11.0); a maximized panel is on the stage. */
  placement?: PanelPlacement;
  /** Name of the extension that contributed this panel, for the panel header. */
  extensionName: string;
  actions: WorkbenchActions;
}

/**
 * Where a panel is drawn now. On desktop, web and a tablet every panel is a
 * stage tab (`stage`, API 1.27.0) unless it asked for the `drawer`; `dock` is
 * what a contribution asks for by default and is no longer drawn there.
 * `sheet` is a phone's sheet over the thread (API 1.20.0): no stage is drawn
 * there, so a document the panel opens must show in the panel.
 */
export type PanelPlacement = "dock" | "drawer" | "stage" | "sheet";

export interface PanelContribution extends ProfileScoped {
  id: string;
  label: string;
  /**
   * `drawer` draws the panel below the conversation and the stage, full width,
   * instead of as a stage tab; one drawer panel shows at a time (API 1.11.0).
   */
  placement?: "dock" | "drawer";
  /**
   * Ignored since API 1.27.0: every panel opens as a stage tab. It told the
   * dock whether the panel filled the space beside the chat (API 1.16.0).
   */
  width?: "narrow" | "wide";
  /**
   * A drawer panel may move onto the stage, maximized (API 1.11.0). Core moves
   * the mounted panel, so its state goes with it, and it is never drawn twice.
   * A dock panel is a stage tab anyway.
   */
  maximizable?: boolean;
  /**
   * Shows the tool somewhere else instead of this panel (a page, an overlay);
   * true when it did. Every way in asks first — its button, `openPanel`,
   * a command — and false opens the panel as usual.
   */
  redirect?(actions: WorkbenchActions): boolean;
  /** The tab's and the button's glyph; `lucide-react` is shared, so pass one of its icons. Missing draws core's fallback. */
  Icon?: PanelIconComponent;
  order?: number;
  /**
   * A button of its own at the right of the stage's tab strip, and in the
   * thread's header while the stage is hidden (API 1.27.0); every other panel
   * is under "More tools" there.
   */
  stageButton?: boolean;
  /** A hook for a count beside the panel's tab title, say running agents; nothing for `undefined` or 0 (API 1.27.0). */
  useBadge?(): number | undefined;
  /** Offered in a phone's actions sheet of a thread row, which opens the thread and then this panel (design 1x, API 1.39.0). */
  threadActions?: boolean;
  /** Unseen background activity. `visible` lets the tool mark its activity as read. */
  useActivity?(visible: boolean): boolean;
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
  /**
   * `actions` are the workbench's, the same a panel is given. `from` names the
   * project whose stage the tab is on, which a draft's need not share with the
   * host (API 1.26.0); core always passes it, without `workspace` when no project is on screen.
   */
  render(params: Params, handle: StageTabHandle, actions: WorkbenchActions, from?: DocumentOrigin): ReactNode;
  /** False drops a tab restored from storage whose params name nothing any more. */
  restore?(params: Params): boolean;
  /**
   * What "Reopen closed tab" keeps of a closed tab: plain JSON to open a fresh
   * one with, never a process, connection or session handle. Without it a
   * closed tab of this kind is not offered again (API 1.52.0).
   */
  reopenParams?(params: Params): Record<string, unknown> | undefined;
  /** Opens a fresh tab from what `reopenParams` kept; by default the kind opens with those params. */
  reopen?(params: Record<string, unknown>, actions: WorkbenchActions): void | Promise<void>;
  /** A line under the tab in "Recently closed" when reopening differs from what was closed ("Opens a new shell"). */
  reopenHint?: string;
  /** One tab for the whole kind, whatever params it is opened with. */
  singleton?: boolean;
}

/** Places besides the palette where a command may also be offered. */
export interface SettingsPageProps {
  /** The open project, for a page that reports what this workspace sees. */
  cwd?: string;
  /** `level` as in `WorkbenchActions.notify` (API 1.60.0). */
  onNotify(message: string, level?: "info" | "warning" | "error"): void;
  /** Opens another place in Settings (`"appearance#setting-…"`, `"extensions/<id>"`) without leaving it (API 1.18.0). */
  onOpenSettings?(target: string): void;
}

/** What a page `registerPage` added is drawn with. */
export interface PageProps {
  actions: WorkbenchActions;
  /** The view on screen: what the page was opened with, or what `navigate` stepped into. */
  params: Readonly<Record<string, unknown>>;
  /**
   * Steps into another view of the page (a detail, a sub-page): `label` follows
   * the page's own in the bar, and Escape, the bar and a phone's back gesture
   * return. `replace` swaps the view on top instead of adding one; `root` (API
   * 1.28.0) leaves every view for the page's own, opened on `params` — pass
   * `replace` with it for an older host.
   */
  navigate(params: Record<string, unknown>, options?: { label?: string; replace?: boolean; root?: boolean }): void;
  /** Back to the thread. */
  close(): void;
  /**
   * The page's `Sidebar` is on screen beside it (API 1.28.0): the page can leave
   * out the navigation the sidebar carries. False on a phone, with the sidebar
   * hidden, and on an older host.
   */
  sidebar?: boolean;
}

/**
 * A page of the app, like Settings: it takes the place of the thread and the
 * stage, and the sidebar stays beside it with Back at its foot (or the page's
 * own `Sidebar`); on a phone it is a screen of its own. The sidebar's foot
 * lists every page, in `order`.
 */
export interface PageContribution extends ProfileScoped {
  id: string;
  label: string;
  /** A sentence or two under the title in the page head, as a Settings page has (API 1.27.0). */
  description?: string;
  Icon?: PanelIconComponent;
  order?: number;
  /** False when the page has another entry on a phone, such as the header's juicebars. Defaults to true. */
  phoneTab?: boolean;
  /**
   * `readable`, the default, is Settings' reading column; `wide` a wider one;
   * `fill` hands the page the whole area to scroll itself, as a stage tab.
   */
  layout?: "readable" | "wide" | "fill";
  /** Words the palette finds the page by, besides its label. */
  keywords?: readonly string[];
  /**
   * A hook for a count on the page's entry (the sidebar's foot, a phone's bottom
   * navigation), say open pull requests; nothing is drawn for `undefined` or 0 (API 1.26.0).
   */
  useBadge?(): number | undefined;
  /**
   * The sidebar's foot leads with the entry (API 1.27.0). Since API 1.28.0 it is
   * an icon with a notification dot when the count is nonzero, the label and
   * count in the tooltip.
   */
  prominent?: boolean;
  /**
   * A hook for a short figure the sidebar's foot shows at its end in place of
   * the icon, say this month's usage; `undefined` draws the icon (API 1.27.0).
   */
  useSummary?(): PageSummary | undefined;
  /**
   * What the sidebar's foot draws for the page at its end, before Settings, in
   * place of the icon and `useSummary` (API 1.28.0): Usage's juicebars. It opens
   * the page itself (`actions.openPage`) and draws the icon when it has nothing.
   */
  Summary?: ComponentType<PageSummaryProps>;
  Component: ComponentType<PageProps>;
  /**
   * What the sidebar shows while the page is open on a desktop, in place of the
   * thread list (API 1.28.0): Settings' column, with Back to thread above it.
   * It gets the page's own props, so a click in it can `navigate` the page.
   * Without one the thread list stays.
   */
  Sidebar?: ComponentType<PageProps>;
}

export interface PageSummaryProps {
  actions: WorkbenchActions;
}

/** A page's figure in the sidebar's foot: `short` stands in where `text` does not fit, `hint` is the tooltip. */
export interface PageSummary {
  text: string;
  short?: string;
  hint?: string;
}

/**
 * A page of Settings an extension owns. Core keeps the Settings screen, its
 * navigation and the pages that must survive safe mode; a page like this one is
 * gone with its extension.
 */
export interface SettingsPageContribution extends ProfileScoped {
  id: string;
  label: string;
  /**
   * What the page governs, in a sentence or two under its title in the page
   * head; the search finds it too (API 1.26.0). The head draws the title, so
   * the page need not.
   */
  description?: string;
  /** @deprecated A page of its own is `registerPage`'s; this one opens without Settings navigation. */
  standalone?: boolean;
  /** The nav glyph, the way a panel passes one. */
  Icon?: PanelIconComponent;
  order?: number;
  /** Words the Settings search and the palette find this page by, besides its label. */
  keywords?: readonly string[];
  /**
   * Where the page sits in Settings' navigation: `app` (the default),
   * `agents`, `projects`, `tools`, `machines` or `diagnostics`; within the
   * group, in `order` (API 1.18.0). `general`, `threads`, `remote` and
   * `extensions`, the names before API 1.61.0, still place a page in `app`,
   * `agents`, `machines` and `app`.
   */
  group?: SettingsNavGroup | SettingsNavGroupAlias;
  /**
   * Rows on the page the Settings search finds by name: `id` is the row's
   * element id (a `SettingRow`'s `id`), which a result scrolls to and
   * `openSettings("<page>#<id>")` opens (API 1.18.0).
   */
  rows?: ReadonlyArray<{ id: string; label: string; keywords?: readonly string[] }>;
  /**
   * The runtime backend this page is about. Such a page gets no nav entry of
   * its own: it is that runtime's card on the Providers page, in `order`.
   */
  runtime?: ThreadBackendKind;
  /**
   * On a runtime's card, the ids of its rows the Runtimes page's buttons open
   * (API 1.27.0): `program`, where the program is installed and updated, and
   * `addInstance`, where another setup of it is added. Without them the
   * buttons open the card.
   */
  runtimeRows?: { program?: string; addInstance?: string };
  /** @deprecated No longer read: "Applies to" offers a project while a row with its own `scope` is on the page. */
  scope?: SettingScope;
  /** A hook for the value a phone's Settings list shows beside the page's name: "2 online" (design 1s, API 1.39.0). */
  useSummary?(): string | undefined;
  Component: ComponentType<SettingsPageProps>;
}

/**
 * Core's own Settings pages a package may add a section to (API 1.13.0):
 * Connections; the list of extensions, above it; each extension's own page,
 * after its settings (both API 1.18.0); Runtimes, below the runtimes (API 1.27.0);
 * General, as rows of one of its cards; and, since API 1.61.0, Threads, as
 * rows of one of its cards, and Diagnostics (`inspector`), below its own sections.
 */
export type CoreSettingsSectionPage = "connections" | "extensions" | "extension" | "runtimes" | "general" | "threads" | "inspector";

/**
 * The page a section joins: one of core's (above), or, since API 1.61.0, the
 * `id` of a page an extension registered, which draws its sections with
 * `SettingsPageSections`.
 */
export type SettingsSectionPage = CoreSettingsSectionPage | (string & Record<never, never>);

/**
 * The cards a section's rows join (design 2i, 2h): General's transcript and
 * privacy (appearance and notify, which General draws only where a package
 * fills them), Threads' new-threads, rail, ask-first, running and
 * long-threads (and threads, drawn only where a package fills it), Connections'
 * this-machine. Such a section draws `SettingRow`s only; the card draws the
 * frame and the heading. `transcript`, `privacy`, `rail`, `ask-first`,
 * `running` and `long-threads` are new in API 1.61.0.
 */
export type SettingsCardId =
  | "appearance" | "notify" | "transcript" | "privacy"
  | "new-threads" | "threads" | "rail" | "ask-first" | "running" | "long-threads"
  | "this-machine";

export interface SettingsSectionProps {
  /** `level` as in `WorkbenchActions.notify` (API 1.60.0). */
  onNotify(message: string, level?: "info" | "warning" | "error"): void;
  /** Reads the page's own data again, after the section changed something it shows. */
  onChanged(): void;
  /** On an extension's page: whose page it is (API 1.18.0). */
  extensionId?: string;
  /** On an extension's page: the open project, whose package folder the extension may live in. */
  cwd?: string;
  /** Opens another place in Settings (`"extensions/<id>"`) without leaving it (API 1.61.0). */
  onOpenSettings?(target: string): void;
}

/**
 * A section a package adds to a Settings page that is not its own, below that
 * page's sections, in `order`: one of core's pages, or another extension's
 * page that draws sections (API 1.61.0). It is gone with its package; the page
 * stays where it is. A section whose page is not there is drawn on its own
 * extension's page in Settings → Extensions.
 */
export interface SettingsSectionContribution extends ProfileScoped {
  id: string;
  page: SettingsSectionPage;
  /** The card on the page its rows join, in `order` among the card's rows. */
  card?: SettingsCardId;
  order?: number;
  /**
   * The section sits under the page's Advanced fold, where the page has one
   * and draws its sections with `SettingsPageSections advanced` (API 1.61.0).
   */
  advanced?: boolean;
  /**
   * Ids of pages this section took over from (API 1.61.0): a link to one opens
   * `page`, so the section's own page can go without breaking old links.
   */
  replaces?: readonly string[];
  /** The rows the Settings search finds in the section, as on a page (API 1.18.0). */
  rows?: ReadonlyArray<{ id: string; label: string; keywords?: readonly string[] }>;
  Component: ComponentType<SettingsSectionProps>;
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
  /** What ⌘⏎ does instead: the row opened in the stage. */
  stage?(actions: WorkbenchActions): void;
  /** As on a command: without `"read"`, a Read-only device shows the row disabled with the reason (API 1.13.0). */
  access?: "read" | "write";
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
  /**
   * The thread index as this window holds it; `running` are the threads with a turn going,
   * `waiting` the ones asking the user something (API 1.59.0).
   */
  index: { projects: readonly UiProject[]; threads: readonly UiSession[]; activeThreadId?: string; running?: readonly string[]; waiting?: readonly string[] };
  /** The tab or prefix the palette is narrowed to; "all" when none is. */
  scope?: "all" | "threads" | "files";
  /** Aborted when the query changes or the palette closes; a late answer is dropped either way. */
  signal: AbortSignal;
}

/**
 * Rows the palette asks for as the user types, beside the commands: threads,
 * projects, anything a query finds. Asked only for a non-empty query, unless
 * it has a `scope`: then also for an empty one, in All and in its own tab.
 */
export interface PaletteSourceContribution {
  id: string;
  /** The section heading its rows stand under; sources with one label share a section. */
  label: string;
  order?: number;
  /** The tab (and prefix: `#` threads, `/` files) that narrows the palette to this source. */
  scope?: "threads" | "files";
  search(query: string, context: PaletteSearchContext): readonly PaletteItem[] | Promise<readonly PaletteItem[]>;
}

/**
 * `thread-title` is the thread title's menu; `file-tab` a button in a file tab's header, which reads the tab from `actions.activeStageTab()`;
 * `runtime-switch` an action the model picker offers with another runtime than the thread's, run with `{ runtime }`;
 * `thread-row` an action on one thread of the compact thread list (swipe or long press), run with `{ threadId }` (API 1.13.0).
 */
export type CommandSurface = "thread-title" | "file-tab" | "runtime-switch" | "thread-row" | "sidebar-footer";

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
  /**
   * `"read"`: safe on a device paired Read only; it only looks, or acts in this
   * window alone (a panel, focus, the device's clipboard or preferences).
   * `"write"`, or nothing: it changes something on the host, so on such a device
   * every surface, the palette and chords included, disables it and says why (API 1.13.0).
   */
  access?: "read" | "write";
  /**
   * Why the command cannot run now, or undefined when it can: every surface
   * disables it with this as the reason, as it does on a Read-only device.
   * `() => hostAvailability(id).reason` ties it to the package's host half (K112).
   */
  unavailable?(): string | undefined;
  run(actions: WorkbenchActions, context?: CommandContext): void | Promise<void>;
}

/**
 * A key chord that runs a command. Spelling follows Pi's keybindings.json
 * ("ctrl+shift+p", "escape") plus "mod" for ⌘ on macOS and Ctrl elsewhere.
 * The first binding of a chord wins; later ones are recorded as conflicts,
 * unless their `when` clauses cannot hold at the same time.
 */
export type {
  KeybindingCollision,
  KeybindingConflict,
  KeybindingContribution,
  ResolvedKeybinding,
  UserKeybinding,
  UserKeymapContribution,
} from "./extension-keybindings";

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
  /** Who asks, for the card's head (`ExtensionPromptFrame`'s `from`): the thread's agent, by its model. */
  asker?: string;
  /** The sub-agent that asks ("GET /orders agent") when the question is a child thread's, shown on its parent's composer. */
  agent?: string | undefined;
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
  /** Sends nothing: the prompt returns to the composer and this line says why (API 1.61.0). */
  stop?: string;
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
  promptAttachments?: readonly UiPromptAttachment[];
  skillDraft?: UiSkillDraft;
  thinkingLevel?: string;
  mode?: string;
}

export interface PromptHookContribution {
  id: string;
  /**
   * Runs first when a pending draft's first prompt leaves the composer.
   * Answering `true` takes the prompt: core creates no thread, the composer
   * empties and the draft stays open for the next one. A hook that throws
   * rejects submission and keeps the draft for retry.
   */
  claimNewThread?(event: NewThreadClaimEvent, actions: WorkbenchActions): Promise<boolean | void>;
  /**
   * Runs before a pending draft's first prompt leaves the composer. It may move
   * the thread to another project or `stop` the send; a failure is reported and
   * the draft stays where it was, so the prompt is never lost to it.
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
  /** The opening tag's `name="value"` pairs; empty for a bare tag. */
  attributes: Readonly<Record<string, string>>;
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
 * Answers the transcript's find (⌘F) for the whole thread, not just the turns
 * a client has loaded. The last one registered wins; without one the find
 * looks through the loaded turns.
 */
/** Older finders may still return only ids; structured results preserve a bounded search's completeness. */
export type TranscriptFindResult = readonly string[] | { messageIds: readonly string[]; truncated: boolean };

export interface TranscriptFinderContribution extends ProfileScoped {
  id: string;
  /** The ids of the thread's messages that hold `query`, oldest first, over its whole history. */
  find(request: { sessionId: string; query: string }): Promise<TranscriptFindResult>;
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
  toggle(model: UiModel, current: UiModel | undefined, runtime?: string, currentRuntime?: string): void;
  /** A plain pick: back to one model. */
  reset(): void;
}

/** What a thread menu reads from the window: chords for its hints, and the commands offered on a thread. */
export interface ThreadMenuLookup {
  keybindingLabel(commandId: string): string | undefined;
  getCommandsFor(surface: CommandSurface): Array<CommandContribution & ContributionOwner>;
}

/**
 * A thread's menu, the same on its title and on its row in the thread list
 * (API 1.37.0). The last one registered wins; without one the title keeps
 * core's own. On the title, `rename` edits the title in place.
 */
export interface ThreadMenuContribution {
  id: string;
  /** Undefined leaves the title's own menu. */
  menu(session: UiSession, lookup: ThreadMenuLookup): MenuSection[] | undefined;
  run(session: UiSession, itemId: string, actions: WorkbenchActions): void;
}

/** A fork the user started: through `entryId` (its turn when one), or the whole thread without one (Duplicate). */
export interface ForkRequest {
  entryId?: string;
  turn?: TranscriptTurn;
  /** The task the fork starts with, for a prompt to show as its draft (API 1.59.0). */
  prompt?: string;
}

/** Asks before every fork the user starts (the `f` key, the thread tree, Duplicate); the last one wins. */
export interface ForkPromptContribution {
  id: string;
  ask(request: ForkRequest): void;
}

/** Which project a document belongs to; absent, the source reads the project it follows. */
export interface DocumentOrigin {
  /** The workspace's id where the host mints one, its path otherwise (API 1.26.0). */
  workspace?: string;
}

/** Who loads the stage's documents and knows which are changed. One at a time. */
export interface DocumentSourceContribution extends ProfileScoped {
  id: string;
  /** The stage names the project its tabs were stored for, which a draft's may be. */
  loadFile(path: string, from?: DocumentOrigin): Promise<UiFileContent>;
  /** Stream media of an explicit originating workspace. Release when its viewer closes. API 1.52.0. */
  loadMedia?(path: string, from: DocumentOrigin & { workspace: string }): Promise<{ url: string; mimeType: string; release?: () => void; mainCheckoutPath?: string; resolvedPath?: string }>;
  /** Publish a workspace fragment as an opaque sandbox on this connection; release when unmounted. */
  loadVisualization?(path: string, from: DocumentOrigin & { workspace: string }, theme?: "light" | "dark"): Promise<{ url: string; release?: () => void }>;
  /** Read a transcript link on its host, including absolute paths and paths outside the workspace. Requires an explicit origin. */
  loadLinkedFile?(path: string, from: DocumentOrigin & { workspace: string }): Promise<UiFileContent>;
  loadDiff(path: string, options?: DiffLoadOptions, from?: DocumentOrigin): Promise<UiFileDiff>;
  /** `workspace` names the project the file belongs to (default: the one followed), `editorId` an editor other than the default, e.g. the `fileManager` (API 1.63.0). */
  openInEditor(relPath: string, options?: { workspace?: string; editorId?: string }): void;
  /** `fileManager` shows a file in the machine's file manager, where it has one (API 1.63.0); like `editor`, absent where the host's files are not this client's. */
  getState(): { changes: UiWorkspaceChanges; editor?: UiEditor; fileManager?: UiEditor };
  subscribe(listener: () => void): () => void;
  listFiles?(): Promise<string[]> | string[];
}

export interface ToolPresentation {
  /** A character or an icon (an icon since API 1.39.0). */
  glyph: ReactNode;
  title: string;
  tone: "neutral" | "read" | "write" | "shell";
  detail: string;
  /** Drawn at the row's end before its state, e.g. an edit's "+4 −2" (API 1.39.0). */
  note?: ReactNode;
  /** Drawn open under the row in place of the output, e.g. an edit's diff (API 1.39.0). */
  body?: ReactNode;
  /** Structured tools can keep their machine payload out of the transcript. */
  output?: "default" | "hidden";
  /**
   * What this tool reaches — a browser, a machine, an MCP server. A group
   * summary hoists a named source to the front of its sentence instead of
   * counting the calls as anonymous tools.
   */
  source?: string;
  /**
   * The file this call read or wrote, as the tool named it. The row offers to
   * open it on the stage, or bring its tab forward (API 1.27.0).
   */
  file?: string;
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
  /** Additional rows from durable tool state, e.g. background returns. Pure; anchors outside the loaded window stay hidden (API 1.61.0). */
  transcriptRows?(props: ToolCardProps & { messages: readonly UiMessage[] }): readonly TranscriptRow[];
}

/** Options an extension declares at activation; Tau renders the settings page from these. */
export type ExtensionOption =
  | { id: string; kind: "toggle"; label: string; defaultValue: boolean }
  | { id: string; kind: "chips"; label: string; values: string[] }
  | { id: string; kind: "select"; label: string; values: Array<{ value: string; label: string }>; defaultValue: string }
  /**
   * A model choice stored as `provider/id`; unset means the thread's model. `thinkingLevelValue` names an optional Pi effort value (API 1.63.0).
   * `emptyLabel` says what an unset choice means where it is not the thread's model, such as another option's default (API 1.79.0).
   */
  | { id: string; kind: "model"; label: string; thinkingLevelValue?: string; emptyLabel?: string };

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

/** The host entry of the same extension package, reached by extension id. */
export interface HostExtensionClient {
  /** Invokes a command the host entry registered with `registerCommand`. */
  invoke(command: string, input?: unknown): Promise<unknown>;
  /** A browser resource path resolved against the connected host. API 1.51.0. */
  resourceUrl?(path: string): string;
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
  resourceUrl?(path: string): string;
  /** Core's own scan of the package folders and the shipped kits; absent without a host. */
  inspect?(cwd: string): Promise<ExtensionInspection>;
  /** Asks the host for a topic's events; absent without a host. */
  watch?(extensionId: string, topic: string): () => void;
}

export type ExtensionEvent = Extract<GlobalHostEvent, { type: "extension-event" }>;

export interface DesktopExtensionContext {
  /** Aborted before rollback or deactivation. New in API 1.69.0. */
  readonly signal?: AbortSignal;
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
  /** A view `actions.openConversationView` shows in place of the transcript (API 1.57.0). */
  registerConversationView?(view: ConversationViewContribution): () => void;
  registerPanel(panel: PanelContribution): () => void;
  /** A kind of tab this extension draws on the stage; `actions.openStageTab` opens one. */
  registerStageTab<Params extends Record<string, unknown>>(tab: StageTabContribution<Params>): () => void;
  /** A page of the Settings modal; core lends the nav entry and the frame. */
  registerSettingsPage(page: SettingsPageContribution): () => void;
  /** A section on one of core's Settings pages (API 1.13.0). */
  registerSettingsSection(section: SettingsSectionContribution): () => void;
  /** A page of the app beside the sidebar, like Settings; `actions.openPage(id)` opens it. */
  registerPage(page: PageContribution): () => void;
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
  /** A faster tier for threads of this kit's runtime, shown in the composer's thinking chip and menu. */
  registerComposerSpeed(speed: ComposerSpeedContribution): () => void;
  /** Changes what the send button does for a thread, such as compacting first. */
  registerComposerSendMode(mode: ComposerSendModeContribution): () => void;
  /** A tab of the composer's Plan sheet, such as a repeating schedule (API 1.65.0). */
  registerComposerPlanner(planner: ComposerPlannerContribution): () => void;
  /** Rows this extension shows in the transcript; `order` sorts rows sharing an anchor. */
  registerTranscriptRows(id: string, order?: number, options?: ProfileScoped): TranscriptRowsHandle;
  /** Replaces the transcript's waiting label for a thread while the label is set; `undefined` clears it. */
  setLiveStatus(sessionId: string, label: string | undefined): void;
  /** This extension's row states by thread id, on every client's thread list; `{}` withdraws them (API 1.56.0). */
  setThreadRowStatuses(statuses: Readonly<Record<string, ThreadRowMark<ReactNode>>>): void;
  /** Publishes how threads this extension created relate to their parents; `undefined` withdraws it. */
  setThreadLineage(lineage: ThreadLineage | undefined): void;
  /**
   * Pictures this extension draws projects with, by a project's `workspaceId`
   * or `path`, as `data:image/` URLs. Every project mark core draws uses them
   * before the host's; the first extension's wins, `undefined` withdraws them.
   */
  setProjectIcons(icons: Readonly<Record<string, string>> | undefined): void;
  /**
   * Pictures for model providers Tau ships no mark for, by provider id, as
   * `data:image/` URLs; every provider mark core draws uses them before the
   * initial. The first extension's wins, `undefined` withdraws them (API 1.29.0).
   */
  setProviderIcons(icons: Readonly<Record<string, string>> | undefined): void;
  /** Replaces this extension's problems in Settings → Inspector; `[]` clears them. */
  setProblems(problems: readonly ExtensionProblem[]): void;
  /**
   * Publishes a value the extensions of one product may share, under an id
   * their own protocol file names. Core never looks inside it, and the offer
   * is withdrawn when this extension deactivates. If a waiting consumer throws,
   * all bindings to this offer are released before publication throws.
   */
  provideService<T>(id: string, value: T): () => void;
  /**
   * Uses a value another extension published, now or as soon as it appears —
   * so activation order does not matter. `use` may return its own disposer,
   * which runs when the provider withdraws or this extension deactivates.
   * Callback and disposer errors identify this consumer and the service id.
   */
  useService<T>(id: string, use: (value: T) => (() => void) | void): () => void;
  /**
   * Changes to other extensions' parts, by part name (API 1.62.0, ADR 0042).
   * Every layer applies, by `order` and then as registered; Customize Kit's,
   * the user's own, comes last.
   */
  registerCustomizations(layer: CustomizationLayer): () => void;
  /** Every part on offer on this client, drawn or customized away (API 1.62.0). */
  customizableParts(): CustomizablePart[];
  /** Runs when parts come or go or the layer changes (API 1.62.0). */
  onPartsChanged(listener: () => void): () => void;
  registerSidebar(contribution: SidebarContribution): () => void;
  registerProjectSource(source: ProjectSourceContribution): () => void;
  /** Threads of elsewhere in a phone's or tablet's thread list, beside this host's (API 1.30.0). */
  registerThreadListSource(source: ThreadListSource): () => void;
  /** Marks on the rows of a phone's or tablet's thread list: the rail's accessories (new after API 1.59.0). */
  registerThreadListAccessory(accessory: ThreadListAccessoryContribution): () => void;
  /** The compact list's sections, such as Thread Rail's Working section (API 1.64.0). */
  registerThreadListLayout(layout: ThreadListLayout): () => void;
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
  /** The menu of a thread, on its title and its row; the last one wins (API 1.37.0). */
  registerThreadMenu(menu: ThreadMenuContribution): () => void;
  registerForkPrompt(prompt: ForkPromptContribution): () => void;
  registerMessageAction(action: MessageActionContribution): () => void;
  /** Draws a tagged block of an assistant reply itself. New in API 1.11.0. */
  registerMessageBlock(block: MessageBlockContribution): () => void;
  /** Lets the transcript's find reach turns that are not loaded yet; the last one wins. */
  registerTranscriptFinder(finder: TranscriptFinderContribution): () => void;
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
