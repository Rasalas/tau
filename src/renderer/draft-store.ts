import { createDraftKey, type DraftKey } from "./composer-scope-store";

const NEW_THREAD_KEY = "tau.active-new-thread.v1";

export interface NewThreadDraft {
  projectPath: string;
  projectName: string;
  sessionId?: string;
  /** Unique draft identity; same-project new-thread requests must not share state. */
  draftId?: string;
}

export function draftKey(sessionId?: string, pending?: NewThreadDraft): DraftKey | undefined {
  if (pending) return createDraftKey(`new:${pending.projectPath}:${pending.draftId ?? "legacy"}`);
  return sessionId ? createDraftKey(`session:${sessionId}`) : undefined;
}

export function readNewThreadDraft(storage: Storage): NewThreadDraft | undefined {
  try {
    const value = JSON.parse(storage.getItem(NEW_THREAD_KEY) ?? "null") as Partial<NewThreadDraft> | null;
    return value && typeof value.projectPath === "string" && typeof value.projectName === "string"
    ? { projectPath: value.projectPath, projectName: value.projectName, ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}) }
      : undefined;
  } catch { return undefined; }
}

export function writeNewThreadDraft(storage: Storage, draft?: NewThreadDraft): void {
  if (draft) storage.setItem(NEW_THREAD_KEY, JSON.stringify(draft));
  else storage.removeItem(NEW_THREAD_KEY);
}
