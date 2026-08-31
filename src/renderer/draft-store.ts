const DRAFTS_KEY = "tau.composer-drafts.v1";
const NEW_THREAD_KEY = "tau.active-new-thread.v1";

export interface NewThreadDraft {
  projectPath: string;
  projectName: string;
  sessionId?: string;
  /** Unique draft identity; same-project new-thread requests must not share state. */
  draftId?: string;
}

function readMap(storage: Storage): Record<string, string> {
  try {
    const value = JSON.parse(storage.getItem(DRAFTS_KEY) ?? "{}");
    return value && typeof value === "object" ? value as Record<string, string> : {};
  } catch { return {}; }
}

export function draftKey(sessionId?: string, pending?: NewThreadDraft): string | undefined {
  if (pending) return `new:${pending.projectPath}:${pending.draftId ?? "legacy"}`;
  return sessionId ? `session:${sessionId}` : undefined;
}

export function readComposerDraft(storage: Storage, key?: string): string {
  return key ? readMap(storage)[key] ?? "" : "";
}

export function writeComposerDraft(storage: Storage, key: string | undefined, text: string): void {
  if (!key) return;
  const drafts = readMap(storage);
  if (text) drafts[key] = text;
  else delete drafts[key];
  storage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
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
