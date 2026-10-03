import type { ClientStorage } from "./client-storage";
import { createDraftKey, type ComposerScopeStore, type DraftKey } from "./composer-scope-store";
import { draftKey, readKeptDrafts, readNewThreadDraft, writeKeptDrafts, type NewThreadDraft } from "./draft-store";

/** A new thread's draft as the thread list shows it, before its first message. */
export interface DraftThread {
  draftId: string;
  projectName: string;
  projectPath: string;
  workspaceId?: string;
  /** The first line of the text, chips still as tokens; empty for a draft nobody typed in. */
  preview: string;
  /** Images waiting in its composer; they live in memory only. */
  attachments: number;
  createdAt: number;
  /** The draft on screen, the one a new thread opened. */
  active: boolean;
  /** Set once the host made a thread for it; that thread's row replaces this one. */
  sessionId?: string;
}

export interface DraftThreadsPorts {
  storage: ClientStorage;
  scopes: ComposerScopeStore;
  newThread: { current(): NewThreadDraft | undefined; subscribe(listener: () => void): () => void };
  publish(drafts: readonly DraftThread[]): void;
  threads?: { listed(sessionId: string): boolean; active(sessionId: string): boolean; subscribe(listener: () => void): () => void };
}

const PREVIEW_LENGTH = 160;

function previewOf(text: string): string {
  return (text.split("\n").find((line) => line.trim()) ?? "").trim().slice(0, PREVIEW_LENGTH);
}

/**
 * The drafts the thread list shows: the one on screen from the moment it
 * opens, and every draft the user left with something in it. An empty draft
 * that is left is gone; one with text or images stays until it is sent,
 * opened again or discarded. Kept drafts live in this client's storage.
 */
export class DraftThreads {
  private kept: NewThreadDraft[];
  private lastActive: DraftThread | undefined;
  private readonly handoffs = new Map<string, DraftThread>();
  private drafts: readonly DraftThread[] = [];
  private scope: DraftKey | undefined;
  private releaseScope: (() => void) | undefined;
  /** The active draft's last typed first line, and the one it sent. */
  private typed: { draftId: string; preview: string } | undefined;
  private sent: { draftId: string; preview: string } | undefined;
  /** When a draft without a start time was first seen, so it keeps its place. */
  private readonly firstSeen = new Map<string, number>();

  constructor(private readonly ports: DraftThreadsPorts) {
    this.kept = readKeptDrafts(ports.storage);
    ports.newThread.subscribe(this.follow);
    ports.threads?.subscribe(this.refresh);
    this.follow();
  }

  list = (): readonly DraftThread[] => this.drafts;

  /** The composer is a thread now; its rail row stays until the index catches up. */
  handoff = (draftId: string, sessionId: string): void => {
    if (this.lastActive?.draftId !== draftId || this.ports.threads?.listed(sessionId)) return;
    this.handoffs.set(sessionId, { ...this.lastActive, sessionId });
    this.refresh();
  };

  /**
   * The draft on screen is being left: kept when it holds text or images,
   * dropped otherwise. False when there was nothing to keep, or it is being sent.
   */
  keep = (draft: NewThreadDraft): boolean => {
    const scope = draftKey(undefined, draft);
    const composer = scope ? this.ports.scopes.getSnapshot(scope) : undefined;
    if (composer?.submissionPending) return false;
    const stored = readNewThreadDraft(this.ports.storage);
    const latest = stored?.draftId === draft.draftId ? stored : draft;
    const text = composer?.draft || latest.draft || "";
    if (!text.trim() && !composer?.attachments.length) return false;
    const { sessionId: _sessionId, ...rest } = latest;
    this.kept = [{ ...rest, createdAt: this.startOf(latest), draft: text }, ...this.kept.filter((entry) => entry.draftId !== draft.draftId)];
    writeKeptDrafts(this.ports.storage, this.kept);
    this.refresh();
    return true;
  };

  /** A kept draft, taken out of the list to be the draft on screen again. */
  take = (draftId: string): NewThreadDraft | undefined => {
    const draft = this.kept.find((entry) => entry.draftId === draftId);
    if (!draft) return undefined;
    this.kept = this.kept.filter((entry) => entry !== draft);
    writeKeptDrafts(this.ports.storage, this.kept);
    this.refresh();
    return draft;
  };

  /** Throws a draft away with what its composer held. */
  discard = (draft: NewThreadDraft): void => {
    const scope = draftKey(undefined, draft);
    if (scope) {
      this.ports.scopes.setDraft(scope, "");
      this.ports.scopes.setAttachments(scope, []);
    }
    const before = this.kept.length;
    this.kept = this.kept.filter((entry) => entry.draftId !== draft.draftId);
    if (this.kept.length !== before) writeKeptDrafts(this.ports.storage, this.kept);
    this.refresh();
  };

  find = (draftId: string): NewThreadDraft | undefined =>
    this.kept.find((entry) => entry.draftId === draftId);

  private follow = (): void => {
    const current = this.ports.newThread.current();
    const scope = current ? createDraftKey(draftKey(undefined, current)) : undefined;
    if (scope !== this.scope) {
      this.releaseScope?.();
      this.scope = scope;
      this.releaseScope = scope ? this.ports.scopes.subscribe(scope, this.refresh) : undefined;
    }
    this.refresh();
  };

  private startOf(draft: NewThreadDraft): number {
    if (draft.createdAt !== undefined) return draft.createdAt;
    const seen = this.firstSeen.get(draft.draftId) ?? Date.now();
    this.firstSeen.set(draft.draftId, seen);
    return seen;
  }

  private row(draft: NewThreadDraft, active: boolean): DraftThread {
    const scope = draftKey(undefined, draft);
    const composer = scope ? this.ports.scopes.getSnapshot(scope) : undefined;
    // The controller's copy of the text is stale; the composer writes the active draft's record in storage.
    const stored = active ? readNewThreadDraft(this.ports.storage) : undefined;
    const typed = previewOf(composer?.draft || (stored?.draftId === draft.draftId ? stored.draft : draft.draft) || "");
    if (active && composer?.submissionPending && this.typed?.draftId === draft.draftId) this.sent = this.typed;
    if (active && typed) this.typed = { draftId: draft.draftId, preview: typed };
    // A send empties the composer before the host has the thread; the row keeps what was sent until its thread takes over.
    const preview = typed || (this.sent?.draftId === draft.draftId ? this.sent.preview : "");
    return {
      draftId: draft.draftId,
      projectName: draft.projectName,
      projectPath: draft.projectPath,
      ...(draft.workspaceId ? { workspaceId: draft.workspaceId } : {}),
      preview,
      attachments: composer?.attachments.length ?? 0,
      createdAt: this.startOf(draft),
      active,
      ...(draft.sessionId ? { sessionId: draft.sessionId } : {}),
    };
  }

  private refresh = (): void => {
    const current = this.ports.newThread.current();
    for (const sessionId of this.handoffs.keys()) {
      if (this.ports.threads?.listed(sessionId)) this.handoffs.delete(sessionId);
    }
    const active = current ? this.row(current, true) : undefined;
    if (active) this.lastActive = active;
    const rows = [
      ...(active ? [active] : []),
      ...[...this.handoffs].map(([sessionId, row]) => Object.assign({}, row, { active: !current && Boolean(this.ports.threads?.active(sessionId)) })),
      ...this.kept.filter((draft) => draft.draftId !== current?.draftId).map((draft) => this.row(draft, false)),
    ].sort((left, right) => right.createdAt - left.createdAt);
    if (sameRows(rows, this.drafts)) return;
    this.drafts = rows;
    this.ports.publish(rows);
  };
}

function sameRows(left: readonly DraftThread[], right: readonly DraftThread[]): boolean {
  return left.length === right.length && left.every((row, index) => {
    const other = right[index]!;
    return row.draftId === other.draftId && row.preview === other.preview && row.attachments === other.attachments
      && row.active === other.active && row.sessionId === other.sessionId && row.projectPath === other.projectPath
      && row.projectName === other.projectName && row.workspaceId === other.workspaceId && row.createdAt === other.createdAt;
  });
}
