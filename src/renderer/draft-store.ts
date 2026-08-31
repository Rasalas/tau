const DRAFTS_KEY = "tau.composer-drafts.v1";
const NEW_THREAD_KEY = "tau.active-new-thread.v1";

export interface NewThreadDraft {
  kind: "draft";
  /** Distinguishes two unstarted threads in the same project. */
  draftId: string;
  projectPath: string;
  projectName: string;
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

function readMap(storage: Storage): Record<string, string> {
  try {
    const value = JSON.parse(storage.getItem(DRAFTS_KEY) ?? "{}");
    return value && typeof value === "object" ? value as Record<string, string> : {};
  } catch { return {}; }
}

export function draftKey(sessionId?: string, pending?: NewThreadDraft): string | undefined {
  if (pending) return `draft:${pending.draftId}`;
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
    if (!value || typeof value.projectPath !== "string" || typeof value.projectName !== "string") return undefined;
    const draft: NewThreadDraft = {
      kind: "draft",
      draftId: typeof value.draftId === "string" && value.draftId.length > 0 ? value.draftId : newDraftId(),
      projectPath: value.projectPath,
      projectName: value.projectName,
    };
    // Migrate the single legacy persisted draft once. The generated ID is
    // written back so a reload keeps the same draft scope.
    if (value.kind !== "draft" || value.draftId !== draft.draftId) writeNewThreadDraft(storage, draft);
    return draft;
  } catch { return undefined; }
}

export function writeNewThreadDraft(storage: Storage, draft?: NewThreadDraft): void {
  if (draft) storage.setItem(NEW_THREAD_KEY, JSON.stringify(draft));
  else storage.removeItem(NEW_THREAD_KEY);
}
