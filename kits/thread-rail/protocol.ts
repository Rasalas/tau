// Type-only imports: both halves and other kits read this file.
import type { ComponentType } from "react";
import type { MenuSection, UiSession, WorkbenchActions } from "tau";

export const THREAD_RAIL_EXTENSION_ID = "tau.thread-rail";
/** Pushed with the whole state whenever a thread's meta or the settings change. */
export const META_EVENT = "meta";
/** Workspace Kit's store, which lends the rail's organizer slot. */
export const WORKSPACE_STORE_SERVICE = "tau.workspace/store";
/** Thread Titles' desktop service (`kits/thread-titles/protocol.ts`): names the thread on screen again. */
export const THREAD_TITLES_SERVICE = "tau.thread-titles/titles";
export interface ThreadTitlesSlice {
  regenerate(actions: WorkbenchActions): Promise<void>;
}
/** Review Kit's host entry; its `pr-status` names Thread Rail as a caller. */
export const REVIEW_EXTENSION_ID = "tau.review";
/**
 * Threads started together from one prompt, for the kits that show them
 * (Agents Kit's panel): `siblingsOf(threadId)` answers the whole group,
 * the thread itself included, or `[]`.
 */
export const SIBLINGS_SERVICE = "tau.thread-rail/siblings";

export interface ThreadSiblingsService {
  siblingsOf(threadId: string): readonly string[];
  subscribe(listener: () => void): () => void;
}

export type SettledBy = "user" | "inactive" | "pr-merged" | "pr-closed";

/** What the kit keeps about one thread; the thread itself is core's. */
export interface ThreadMeta {
  pinned?: boolean;
  /** Rank among the pinned threads, lowest first. */
  pinOrder?: number;
  /** Rank among the active threads; a thread without one sits above every arranged thread. */
  order?: number;
  /** Epoch ms the thread wakes at. */
  snoozedUntil?: number;
  settledAt?: number;
  settledBy?: SettledBy;
  /** The user took the thread off the shelf; no rule settles it until it moves after this. */
  keptAt?: number;
  /** The request that settled the thread once; it never settles it again. */
  settledForRequest?: string;
  /** Threads started together from one prompt share this. */
  siblingGroupId?: string;
  /** The model a sibling started with, `provider/id`. */
  model?: string;
  /** The last turn the host saw start or end in this thread. */
  activityAt?: number;
  /** Out of the rail, listed under Settings → Archived; new work brings it back. */
  archivedAt?: number;
}

/** Actions the rail can ask about first. */
export type RailQuestionAction = "delete" | "archive" | "unpin";

/** The kit option behind each question and whether it asks by default. */
export const RAIL_CONFIRMATIONS: Record<RailQuestionAction, { option: string; fallback: boolean; label: string; hint: string }> = {
  delete: { option: "confirm-delete", fallback: true, label: "Before deleting a thread", hint: "Deleted threads wait in the trash under Settings → Archived" },
  archive: { option: "confirm-archive", fallback: false, label: "Before archiving a thread", hint: "Archived threads leave the rail until new work brings them back" },
  unpin: { option: "confirm-unpin", fallback: false, label: "Before unpinning a thread", hint: "From the row menu, the command or a selection" },
};

/** A question the rail is waiting on; `answer` settles it. */
export interface RailQuestion {
  action: RailQuestionAction;
  sessions: readonly UiSession[];
  answer(confirmed: boolean, dontAskAgain?: boolean): void;
}

/** A field set to `null` is removed; a patch of `null` forgets the thread. */
export type ThreadMetaPatch = { [Key in keyof ThreadMeta]?: ThreadMeta[Key] | null };

export interface RailSettings {
  /** Settle a thread that has been quiet this many days; absent means never. */
  inactiveDays?: number;
  /** Settle a thread whose pull or merge request merged. */
  onMerged: boolean;
  /** Settle a thread whose request was closed without merging. */
  onClosed: boolean;
}

export interface RailState {
  threads: Readonly<Record<string, ThreadMeta>>;
  settings: RailSettings;
}

export interface RailStartRequest {
  /** Absolute path of the checkout the thread runs in. */
  cwd: string;
  prompt: string;
  model?: { provider: string; id: string };
  siblingGroupId?: string;
}

export type RailSectionId = "pinned" | "active" | "snoozed" | "settled" | "archived";

/** Every section a thread can be in; the rail draws all but `archived`. */
export interface RailSections {
  pinned: UiSession[];
  active: UiSession[];
  snoozed: UiSession[];
  settled: UiSession[];
  archived: UiSession[];
}

/** Pushed with the trash whenever a thread goes in or comes out. */
export const TRASH_EVENT = "trash";

/** A deleted thread, as the host's trash lists it. */
export interface TrashedThread {
  sessionId: string;
  cwd: string;
  title: string;
  backendKind: string;
  deletedAt: number;
  purgeAt: number;
}

/** Where a dragged thread lands, in Workspace Kit's words. */
export interface RailDropTarget {
  sectionId: string;
  beforeThreadId?: string;
}

/** Workspace Kit's organizer contract, the part this kit fills. */
export interface RailOrganizer {
  subscribe(listener: () => void): () => void;
  getVersion(): number;
  sections(threads: readonly UiSession[]): Array<{ id: string; label?: string; threads: readonly UiSession[]; shelf?: boolean; collapsed?: boolean; settled?: boolean }>;
  menu(session: UiSession): MenuSection[];
  runMenu(session: UiSession, itemId: string, actions: WorkbenchActions): void;
  toggleSettled(session: UiSession): void;
  dropLabel(threadId: string, drop: RailDropTarget): string | undefined;
  drop(threadId: string, drop: RailDropTarget): void;
  Layer?: ComponentType<{ actions: WorkbenchActions }>;
  bulkMenu?(sessions: readonly UiSession[]): MenuSection[];
  runBulkMenu?(sessions: readonly UiSession[], itemId: string, actions: WorkbenchActions): void;
}

/** The slice of Workspace Kit's store (`tau.workspace/store`) this kit uses. */
export interface WorkspaceStoreSlice {
  getSnapshot(): { draftPending: boolean; workspace?: { isRepo: boolean }; railProjectFilter?: string };
  /** Absent in a Workspace Kit before API 1.11.0; the row menu leaves the item out then. */
  setRailProjectFilter?(projectName: string | undefined): void;
  openProjectSettings?(thread: Pick<UiSession, "projectPath" | "projectName" | "workspaceId">): void;
  subscribe(listener: () => void): () => void;
  registerThreadRailOrganizer(organizer: RailOrganizer): () => void;
  registerThreadRowAccessory(accessory: ComponentType<{ session: UiSession }>): () => void;
  prepareThreadWorktree(request: {
    prompt: string;
    preparing(message: string): void;
    force?: boolean;
    branchSuffix?: string;
  }): Promise<{ workspace?: { workspaceId: string; displayPath: string } }>;
}
