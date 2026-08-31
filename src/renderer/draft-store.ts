import { createDraftKey, type DraftKey } from "./composer-scope-store";

const DRAFTS_KEY = "tau.composer-drafts.v1";
const NEW_THREAD_KEY = "tau.active-new-thread.v1";

export interface NewThreadDraft {
  projectPath: string;
  projectName: string;
  sessionId?: string;
  /** Unique draft identity; same-project new-thread requests must not share state. */
  draftId?: string;
  /** Text-only recovery state; pending attachments remain memory-only. */
  draft?: string;
}

export function draftKey(sessionId?: string, pending?: NewThreadDraft): DraftKey | undefined {
  if (pending) return createDraftKey(`new:${pending.projectPath}:${pending.draftId ?? "legacy"}`);
  return sessionId ? createDraftKey(`session:${sessionId}`) : undefined;
}

function readComposerDrafts(storage: Storage): Record<string, string> {
  try {
    const value = JSON.parse(storage.getItem(DRAFTS_KEY) ?? "{}");
    return value && typeof value === "object" ? value as Record<string, string> : {};
  } catch {
    return {};
  }
}

export function readComposerDraft(storage: Storage, key?: DraftKey | string): string {
  // A pending new thread is intentionally persisted in its lifecycle record,
  // not in the generic composer map: that map may contain attachment-adjacent
  // state and must stay empty until a real thread exists.
  if (typeof key === "string" && key.startsWith("new:")) return readNewThreadDraft(storage)?.draft ?? "";
  return key ? readComposerDrafts(storage)[key] ?? "" : "";
}

export function writeComposerDraft(storage: Storage, key: DraftKey | string | undefined, text: string): void {
  if (!key) return;
  if (typeof key === "string" && key.startsWith("new:")) {
    const pending = readNewThreadDraft(storage);
    if (pending) writeNewThreadDraft(storage, { ...pending, draft: text || undefined });
    return;
  }
  const drafts = readComposerDrafts(storage);
  if (text) drafts[key] = text;
  else delete drafts[key];
  storage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
}

export function readNewThreadDraft(storage: Storage): NewThreadDraft | undefined {
  try {
    const value = JSON.parse(storage.getItem(NEW_THREAD_KEY) ?? "null") as Partial<NewThreadDraft> | null;
    return value && typeof value.projectPath === "string" && typeof value.projectName === "string"
    ? {
      projectPath: value.projectPath,
      projectName: value.projectName,
      ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
      ...(typeof value.draftId === "string" ? { draftId: value.draftId } : {}),
      ...(typeof value.draft === "string" ? { draft: value.draft } : {}),
    }
      : undefined;
  } catch { return undefined; }
}

export function writeNewThreadDraft(storage: Storage, draft?: NewThreadDraft): void {
  if (draft) storage.setItem(NEW_THREAD_KEY, JSON.stringify(draft));
  else storage.removeItem(NEW_THREAD_KEY);
}
