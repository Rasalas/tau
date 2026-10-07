import type { UiSession } from "../shared/contracts";
import type { ClientStorage } from "./client-storage";
import type { StageState } from "./stage";
import { STORAGE_KEYS, threadStageKey } from "./storage-keys";
import { decodeStageState, takeProjectLayout, type ThreadDockState } from "./workbench-layout-state";

/** What one thread or draft left on screen: its stage, whether it filled the centre or was folded, and its dock. */
export interface ThreadStage {
  stage: StageState;
  maximized: boolean;
  /** The stage was hidden. */
  folded?: boolean;
  dock: ThreadDockState;
}

/** A settled thread's layout goes once it has not been opened for this long. */
export const SETTLED_STAGE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** At most this many layouts are kept; the ones opened longest ago go first. */
export const MAX_THREAD_STAGES = 200;
/** A thread the index does not list, or a draft the list no longer holds, may be one being promoted. */
const UNLISTED_GRACE_MS = 10 * 60 * 1000;
const SWEEP_EVERY_MS = 10 * 60 * 1000;

const THREAD = "thread:";
const DRAFT = "draft:";

/**
 * Whose stage is on screen: a thread by its id, a new thread's draft by its
 * draft id. A draft that already has a thread (a failed first send brought it
 * back) is that thread's.
 */
export function stageOwner(sessionId: string | undefined, draft?: { draftId: string; sessionId?: string }): string | undefined {
  if (draft) return draft.sessionId ? `${THREAD}${draft.sessionId}` : `${DRAFT}${draft.draftId}`;
  return sessionId ? `${THREAD}${sessionId}` : undefined;
}

export interface ThreadStagesPorts {
  storage: ClientStorage;
  /** The thread index as the window has it now. */
  threads(): readonly UiSession[];
  /** Draft ids the thread list still holds: the one on screen and the ones kept. */
  drafts(): readonly string[];
  settled?(): readonly string[];
  now?(): number;
}

function isEmpty(layout: ThreadStage): boolean {
  return layout.stage.tabs.length === 0 && !layout.stage.closed?.length && !layout.dock.open && !layout.dock.drawer;
}

function parse(raw: string | null): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function decodeDock(value: unknown): ThreadDockState {
  const dock = value as Record<string, unknown> | undefined;
  return {
    open: dock?.open === true,
    ...(typeof dock?.activePanel === "string" && dock.activePanel ? { activePanel: dock.activePanel } : {}),
    ...(typeof dock?.drawer === "string" && dock.drawer ? { drawer: dock.drawer } : {}),
  };
}

/**
 * Each thread's and each draft's stage, kept in client storage under
 * `tau.stage.v2:<owner>`, so switching back shows what was left there. The
 * store also hands a draft's layout to the thread it becomes, gives the old
 * per-project stage to one thread, and forgets the layouts of threads that
 * are gone or long settled.
 */
export class ThreadStages {
  /** Drafts that became threads while this window ran. */
  private readonly promoted = new Map<string, string>();
  private shown: string | undefined;
  /** The first thread shown after start is the one the host had open: it takes its project's old stage. */
  private firstThread = true;
  private lastSweep: number | undefined;

  constructor(private readonly ports: ThreadStagesPorts) {}

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  /** The owner a draft became, when it was promoted. */
  promotedTo = (owner: string): string | undefined => this.promoted.get(owner);

  private resolve(owner: string): string {
    return this.promoted.get(owner) ?? owner;
  }

  /**
   * The layout `owner` left, or the one its project kept before stages were
   * per thread, when this thread is the one to take it; undefined for a new one.
   */
  read = (owner: string, workspace?: string): ThreadStage | undefined => {
    this.shown = this.resolve(owner);
    const isThread = owner.startsWith(THREAD);
    const first = isThread && this.firstThread;
    if (isThread) this.firstThread = false;
    const stored = parse(this.ports.storage.get(threadStageKey(this.resolve(owner))));
    if (stored) {
      const stage = decodeStageState(stored);
      return {
        stage,
        maximized: stored.maximized === true && stage.tabs.length > 0,
        ...(stored.folded === true && stage.tabs.length > 0 ? { folded: true } : {}),
        dock: decodeDock(stored.dock),
      };
    }
    if (!isThread || !workspace || (!first && !this.isLatest(owner.slice(THREAD.length), workspace))) return undefined;
    const taken = takeProjectLayout(this.ports.storage, workspace);
    if (!taken) return undefined;
    const layout = { stage: taken.stage, maximized: false, dock: taken.dock };
    this.write(owner, layout);
    return layout;
  };

  /** An empty layout is what a new thread shows, so it is not kept. */
  write = (owner: string, layout: ThreadStage): void => {
    const key = threadStageKey(this.resolve(owner));
    try {
      if (isEmpty(layout)) { this.ports.storage.remove(key); return; }
      this.ports.storage.set(key, JSON.stringify({
        tabs: layout.stage.tabs,
        // Undefined members are left out.
        activeId: layout.stage.activeId,
        splitId: layout.stage.splitId,
        closed: layout.stage.closed?.length ? layout.stage.closed : undefined,
        ...(layout.maximized && layout.stage.tabs.length > 0 ? { maximized: true } : {}),
        ...(layout.folded && layout.stage.tabs.length > 0 ? { folded: true } : {}),
        dock: layout.dock,
        seenAt: this.now(),
      }));
    } catch {
      // Restoring the layout is a convenience; a full or blocked store is not worth surfacing.
    }
  };

  /** The draft's first message made thread `sessionId`: its layout is that thread's from now on. */
  promote = (draftId: string, sessionId: string): void => {
    const from = `${DRAFT}${draftId}`;
    const to = `${THREAD}${sessionId}`;
    this.promoted.set(from, to);
    if (this.shown === from) this.shown = to;
    const { storage } = this.ports;
    const layout = parse(storage.get(threadStageKey(from)));
    storage.remove(threadStageKey(from));
    if (layout && storage.get(threadStageKey(to)) === null) {
      storage.set(threadStageKey(to), JSON.stringify({ ...layout, seenAt: this.now() }));
    }
  };

  /** The thread was deleted. */
  forgetThread = (sessionId: string): void => {
    this.ports.storage.remove(threadStageKey(`${THREAD}${sessionId}`));
  };

  /**
   * Drops the layouts nobody will see again: a deleted thread's, a settled
   * thread's not opened for 30 days, a draft's that is gone, and the oldest
   * beyond 200. The one on screen stays. Runs on the host's index, which is
   * complete, never on the cached one; at most every ten minutes after the first.
   */
  sweep = (): void => {
    const now = this.now();
    if (this.lastSweep !== undefined && now - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = now;
    const { storage } = this.ports;
    const threads = new Set(this.ports.threads().map((thread) => thread.id));
    const drafts = new Set(this.ports.drafts());
    const settled = new Set(this.ports.settled?.() ?? []);
    const prefix = `${STORAGE_KEYS.threadStage}:`;
    const kept: Array<{ key: string; seenAt: number }> = [];
    for (const key of storage.keys(prefix)) {
      const owner = key.slice(prefix.length);
      if (owner === this.shown) continue;
      const stored = parse(storage.get(key));
      const seenAt = typeof stored?.seenAt === "number" ? stored.seenAt : 0;
      const age = now - seenAt;
      const id = owner.startsWith(THREAD) ? owner.slice(THREAD.length) : owner.startsWith(DRAFT) ? owner.slice(DRAFT.length) : undefined;
      const gone = !stored || id === undefined
        || (owner.startsWith(THREAD) && ((!threads.has(id) && age > UNLISTED_GRACE_MS) || (settled.has(id) && age > SETTLED_STAGE_AGE_MS)))
        || (owner.startsWith(DRAFT) && !drafts.has(id) && age > UNLISTED_GRACE_MS);
      if (gone) storage.remove(key);
      else kept.push({ key, seenAt });
    }
    kept.sort((left, right) => right.seenAt - left.seenAt).slice(MAX_THREAD_STAGES).forEach(({ key }) => storage.remove(key));
  };

  /** The project's most recently active thread the user started. */
  private isLatest(sessionId: string, workspace: string): boolean {
    let latest: UiSession | undefined;
    for (const thread of this.ports.threads()) {
      if (thread.parentThreadId || (thread.workspaceId !== workspace && thread.projectPath !== workspace)) continue;
      if (!latest || thread.modifiedAt > latest.modifiedAt) latest = thread;
    }
    return latest?.id === sessionId;
  }
}

