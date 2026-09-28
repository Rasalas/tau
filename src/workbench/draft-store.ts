import type { UiModel } from "../shared/contracts";
import type { ClientStorage } from "./client-storage";
import { STORAGE_KEYS } from "./storage-keys";
import { createDraftKey, type DraftKey } from "./composer-scope-store";

const DRAFTS_KEY = STORAGE_KEYS.composerDrafts;
const NEW_THREAD_KEY = STORAGE_KEYS.activeNewThread;
const KEPT_DRAFTS_KEY = STORAGE_KEYS.keptDrafts;

export interface NewThreadDraft {
  kind: "draft";
  /** Distinguishes two unstarted threads in the same project. */
  draftId: string;
  /** @deprecated Display only; the host is addressed with `workspaceId`. */
  projectPath: string;
  /** Opaque identity of the draft's project on the host. */
  workspaceId?: string;
  projectName: string;
  /** When the draft began; the list orders drafts by it. */
  createdAt?: number;
  sessionId?: string;
  /** The runtime the thread is created on; absent means the preference for new threads. */
  runtime?: string;
  /** Explicit composer choice for this thread; never applied to the previously active runtime. */
  model?: UiModel;
  /** The thinking level chosen with it. */
  thinkingLevel?: string;
  /** The runtime `model` and `thinkingLevel` were chosen from; absent means Pi. They go to no other. */
  selectionRuntime?: string;
  /** The interaction mode the thread starts in; `default` when absent. */
  mode?: string;
  /** What was chosen for each runtime the draft left, so coming back finds it again. */
  runtimeSelections?: Record<string, DraftRuntimeSelection>;
  /** Text-only recovery state; pending attachments remain memory-only. */
  draft?: string;
  /** What extensions keep beside the text, as JSON, by extension id. */
  extensions?: Record<string, string>;
}

/** A draft's model, level and mode for one runtime. */
export interface DraftRuntimeSelection {
  model?: UiModel;
  thinkingLevel?: string;
  mode?: string;
}

function readModel(value: unknown): UiModel | undefined {
  const model = value as Partial<UiModel> | undefined;
  return model && typeof model === "object" && typeof model.provider === "string" && typeof model.id === "string" && typeof model.name === "string"
    ? { provider: model.provider, id: model.id, name: model.name }
    : undefined;
}

function readSelections(value: unknown): Record<string, DraftRuntimeSelection> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, DraftRuntimeSelection> = {};
  for (const [runtime, raw] of Object.entries(value as Record<string, Record<string, unknown>>)) {
    if (!raw || typeof raw !== "object") continue;
    const model = readModel(raw.model);
    result[runtime] = {
      ...(model ? { model } : {}),
      ...(typeof raw.thinkingLevel === "string" ? { thinkingLevel: raw.thinkingLevel } : {}),
      ...(typeof raw.mode === "string" && raw.mode ? { mode: raw.mode } : {}),
    };
  }
  return Object.keys(result).length ? result : undefined;
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
    createdAt: Date.now(),
  };
}

export function draftKey(sessionId?: string, pending?: NewThreadDraft): DraftKey | undefined {
  if (pending) return createDraftKey(`new:${pending.projectPath}:${pending.draftId}`);
  return sessionId ? createDraftKey(`session:${sessionId}`) : undefined;
}

/** What `draftKey` was made from: a thread's id, or a draft's id (a draft id holds no colon). */
export function draftKeyOwner(key: string): { sessionId: string } | { draftId: string } | undefined {
  if (key.startsWith("session:")) return { sessionId: key.slice("session:".length) };
  if (key.startsWith("new:")) {
    const draftId = key.slice(key.lastIndexOf(":") + 1);
    return draftId ? { draftId } : undefined;
  }
  return undefined;
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

function parseNewThreadDraft(value: Partial<NewThreadDraft> | null): NewThreadDraft | undefined {
  if (!value || typeof value !== "object" || typeof value.projectPath !== "string" || typeof value.projectName !== "string") return undefined;
  return {
    kind: "draft",
    draftId: typeof value.draftId === "string" && value.draftId.length > 0 ? value.draftId : newDraftId(),
    projectPath: value.projectPath,
    ...(typeof value.workspaceId === "string" ? { workspaceId: value.workspaceId } : {}),
    projectName: value.projectName,
    ...(typeof value.createdAt === "number" ? { createdAt: value.createdAt } : {}),
    ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
    ...(typeof value.runtime === "string" && value.runtime ? { runtime: value.runtime } : {}),
    ...(readModel(value.model) ? { model: readModel(value.model) } : {}),
    ...(typeof value.thinkingLevel === "string" ? { thinkingLevel: value.thinkingLevel } : {}),
    ...(typeof value.selectionRuntime === "string" ? { selectionRuntime: value.selectionRuntime } : {}),
    ...(typeof value.mode === "string" && value.mode ? { mode: value.mode } : {}),
    ...(readSelections(value.runtimeSelections) ? { runtimeSelections: readSelections(value.runtimeSelections) } : {}),
    ...(typeof value.draft === "string" ? { draft: value.draft } : {}),
    ...(isStringRecord(value.extensions) ? { extensions: value.extensions } : {}),
  };
}

export function readNewThreadDraft(storage: ClientStorage): NewThreadDraft | undefined {
  try {
    const value = JSON.parse(storage.get(NEW_THREAD_KEY) ?? "null") as Partial<NewThreadDraft> | null;
    const draft = parseNewThreadDraft(value);
    if (!draft || !value) return undefined;
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

/** The drafts the user left with text in them; attachments stay in memory, so a draft without text is not kept. */
export function readKeptDrafts(storage: ClientStorage): NewThreadDraft[] {
  try {
    const value = JSON.parse(storage.get(KEPT_DRAFTS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      const draft = parseNewThreadDraft(entry as Partial<NewThreadDraft>);
      return draft && typeof (entry as Partial<NewThreadDraft>).draftId === "string" ? [draft] : [];
    });
  } catch { return []; }
}

export function writeKeptDrafts(storage: ClientStorage, drafts: readonly NewThreadDraft[]): void {
  const withText = drafts.filter((draft) => draft.draft?.trim());
  if (withText.length) storage.set(KEPT_DRAFTS_KEY, JSON.stringify(withText));
  else storage.remove(KEPT_DRAFTS_KEY);
}
