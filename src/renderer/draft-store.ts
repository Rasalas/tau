import type { ClientStorage } from "./client-storage";
import { STORAGE_KEYS } from "./storage-keys";
import { createDraftKey, type DraftKey } from "./composer-scope-store";

const DRAFTS_KEY = STORAGE_KEYS.composerDrafts;
const NEW_THREAD_KEY = STORAGE_KEYS.activeNewThread;

export interface NewThreadDraft {
  kind: "draft";
  /** Distinguishes two unstarted threads in the same project. */
  draftId: string;
  projectPath: string;
  projectName: string;
  sessionId?: string;
  /** Text-only recovery state; pending attachments remain memory-only. */
  draft?: string;
}

let draftSequence = 0;

function newDraftId(): string {
  const crypto = globalThis.crypto;
  if (crypto?.randomUUID) return `draft-${crypto.randomUUID()}`;
  draftSequence += 1;
  return `draft-${Date.now()}-${draftSequence}`;
}

export function createNewThreadDraft(project: Pick<NewThreadDraft, "projectPath" | "projectName">): NewThreadDraft {
  return {
    kind: "draft",
    draftId: newDraftId(),
    projectPath: project.projectPath,
    projectName: project.projectName,
  };
}

export function draftKey(sessionId?: string, pending?: NewThreadDraft): DraftKey | undefined {
  if (pending) return createDraftKey(`new:${pending.projectPath}:${pending.draftId}`);
  return sessionId ? createDraftKey(`session:${sessionId}`) : undefined;
}

function readComposerDrafts(storage: ClientStorage): Record<string, string> {
  try {
    const value = JSON.parse(storage.get(DRAFTS_KEY) ?? "{}");
    return value && typeof value === "object" ? value as Record<string, string> : {};
  } catch {
    return {};
  }
}

export function readComposerDraft(storage: ClientStorage, key?: DraftKey | string): string {
  // A pending new thread is intentionally persisted in its lifecycle record,
  // not in the generic composer map: that map may contain attachment-adjacent
  // state and must stay empty until a real thread exists.
  if (typeof key === "string" && key.startsWith("new:")) return readNewThreadDraft(storage)?.draft ?? "";
  return key ? readComposerDrafts(storage)[key] ?? "" : "";
}

export function writeComposerDraft(storage: ClientStorage, key: DraftKey | string | undefined, text: string): void {
  if (!key) return;
  if (typeof key === "string" && key.startsWith("new:")) {
    const pending = readNewThreadDraft(storage);
    if (pending) writeNewThreadDraft(storage, { ...pending, draft: text || undefined });
    return;
  }
  const drafts = readComposerDrafts(storage);
  if (text) drafts[key] = text;
  else delete drafts[key];
  storage.set(DRAFTS_KEY, JSON.stringify(drafts));
}

export function readNewThreadDraft(storage: ClientStorage): NewThreadDraft | undefined {
  try {
    const value = JSON.parse(storage.get(NEW_THREAD_KEY) ?? "null") as Partial<NewThreadDraft> | null;
    if (!value || typeof value.projectPath !== "string" || typeof value.projectName !== "string") return undefined;
    const draft: NewThreadDraft = {
      kind: "draft",
      draftId: typeof value.draftId === "string" && value.draftId.length > 0 ? value.draftId : newDraftId(),
      projectPath: value.projectPath,
      projectName: value.projectName,
      ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
      ...(typeof value.draft === "string" ? { draft: value.draft } : {}),
    };
    // Migrate the single legacy persisted draft once. The generated ID is
    // written back so a reload keeps the same draft scope.
    if (value.kind !== "draft" || value.draftId !== draft.draftId) writeNewThreadDraft(storage, draft);
    return draft;
  } catch { return undefined; }
}

export function writeNewThreadDraft(storage: ClientStorage, draft?: NewThreadDraft): void {
  if (draft) storage.set(NEW_THREAD_KEY, JSON.stringify(draft));
  else storage.remove(NEW_THREAD_KEY);
}
