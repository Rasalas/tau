import type { UiModel } from "../shared/contracts";
import type { ClientStorage } from "./client-storage";
import { STORAGE_KEYS } from "./storage-keys";
import { createDraftKey, type DraftKey } from "./composer-scope-store";

const DRAFTS_KEY = STORAGE_KEYS.composerDrafts;
const NEW_THREAD_KEY = STORAGE_KEYS.activeNewThread;

export interface NewThreadDraft {
  kind: "draft";
  /** Distinguishes two unstarted threads in the same project. */
  draftId: string;
  /** @deprecated Display only; the host is addressed with `workspaceId`. */
  projectPath: string;
  /** Opaque identity of the draft's project on the host. */
  workspaceId?: string;
  projectName: string;
  sessionId?: string;
  /** Explicit composer choice for this thread; never applied to the previously active runtime. */
  model?: UiModel;
  /** The interaction mode the thread starts in; `default` when absent. */
  mode?: string;
  /** Text-only recovery state; pending attachments remain memory-only. */
  draft?: string;
  /** What extensions keep beside the text, as JSON, by extension id. */
  extensions?: Record<string, string>;
}

let draftSequence = 0;

function newDraftId(): string {
  const crypto = globalThis.crypto;
  if (crypto?.randomUUID) return `draft-${crypto.randomUUID()}`;
  draftSequence += 1;
  return `draft-${Date.now()}-${draftSequence}`;
}

export function createNewThreadDraft(project: Pick<NewThreadDraft, "projectPath" | "projectName" | "workspaceId">): NewThreadDraft {
  return {
    kind: "draft",
    draftId: newDraftId(),
    projectPath: project.projectPath,
    ...(project.workspaceId ? { workspaceId: project.workspaceId } : {}),
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

/** The record belongs to the draft this key names, and to no other. */
function pendingForKey(storage: ClientStorage, key: string): NewThreadDraft | undefined {
  const pending = readNewThreadDraft(storage);
  return pending && draftKey(undefined, pending) === key ? pending : undefined;
}

export function readComposerDraft(storage: ClientStorage, key?: DraftKey | string): string {
  // A pending new thread is intentionally persisted in its lifecycle record,
  // not in the generic composer map: that map may contain attachment-adjacent
  // state and must stay empty until a real thread exists.
  if (typeof key === "string" && key.startsWith("new:")) return pendingForKey(storage, key)?.draft ?? "";
  return key ? readComposerDrafts(storage)[key] ?? "" : "";
}

export function writeComposerDraft(storage: ClientStorage, key: DraftKey | string | undefined, text: string): void {
  if (!key) return;
  if (typeof key === "string" && key.startsWith("new:")) {
    const pending = pendingForKey(storage, key);
    if (pending) writeNewThreadDraft(storage, { ...pending, draft: text || undefined });
    return;
  }
  const drafts = readComposerDrafts(storage);
  if (text) drafts[key] = text;
  else delete drafts[key];
  storage.set(DRAFTS_KEY, JSON.stringify(drafts));
}

const isStringRecord = (value: unknown): value is Record<string, string> =>
  Boolean(value) && typeof value === "object" && Object.values(value as object).every((entry) => typeof entry === "string");

/** Extension state lives in the same map as the text, under a key no draft key can take. */
const extensionEntry = (key: string, owner: string) => `ext:${owner}:${key}`;

/**
 * What an extension keeps beside a draft's text — its chips, say — so a
 * reload brings both back. `undefined` when nothing was kept or it does not parse.
 */
export function readComposerDraftState(storage: ClientStorage, key: DraftKey | string | undefined, owner: string): unknown {
  if (!key) return undefined;
  const raw = key.startsWith("new:")
    ? pendingForKey(storage, key)?.extensions?.[owner]
    : readComposerDrafts(storage)[extensionEntry(key, owner)];
  if (raw === undefined) return undefined;
  try { return JSON.parse(raw) as unknown; } catch { return undefined; }
}

export function writeComposerDraftState(storage: ClientStorage, key: DraftKey | string | undefined, owner: string, value: unknown): void {
  if (!key) return;
  const raw = value === undefined ? undefined : JSON.stringify(value);
  if (key.startsWith("new:")) {
    const pending = pendingForKey(storage, key);
    if (!pending) return;
    const extensions = { ...pending.extensions };
    if (raw === undefined) delete extensions[owner];
    else extensions[owner] = raw;
    const { extensions: _previous, ...rest } = pending;
    writeNewThreadDraft(storage, Object.keys(extensions).length > 0 ? { ...rest, extensions } : rest);
    return;
  }
  const drafts = readComposerDrafts(storage);
  if (raw === undefined) delete drafts[extensionEntry(key, owner)];
  else drafts[extensionEntry(key, owner)] = raw;
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
      ...(typeof value.workspaceId === "string" ? { workspaceId: value.workspaceId } : {}),
      projectName: value.projectName,
      ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
      ...(value.model && typeof value.model === "object"
        && typeof value.model.provider === "string"
        && typeof value.model.id === "string"
        && typeof value.model.name === "string"
        ? { model: { provider: value.model.provider, id: value.model.id, name: value.model.name } }
        : {}),
      ...(typeof value.mode === "string" && value.mode ? { mode: value.mode } : {}),
      ...(typeof value.draft === "string" ? { draft: value.draft } : {}),
      ...(isStringRecord(value.extensions) ? { extensions: value.extensions } : {}),
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
