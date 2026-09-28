import type { UiMessage, UiToolRun, UiTurnActivityEntry } from "../shared/contracts";
import type { UiWorkspaceChanges } from "../shared/workspace-kit-types";
import type { ClientStorage } from "./client-storage";
import { STORAGE_KEYS } from "./storage-keys";

const TURN_ACTIVITY_CACHE_KEY = STORAGE_KEYS.turnActivityCache;

export interface CachedTurnActivity {
  sessionId: string;
  /** Kept for older caches; Workspace Kit stores its own baseline now. */
  baseline?: UiWorkspaceChanges;
  tools: UiToolRun[];
  anchorMessageId?: string;
}

function boundedTools(tools: UiToolRun[]): UiToolRun[] {
  return tools.slice(-200).map((tool) => ({
    ...tool,
    output: tool.output && tool.output.length > 8_192
      ? `${tool.output.slice(0, 8_192)}\n[Cached output truncated]`
      : tool.output,
  }));
}

export function readCachedTurnActivity(storage: ClientStorage, sessionId: string): CachedTurnActivity | undefined {
  try {
    const entries = JSON.parse(storage.get(TURN_ACTIVITY_CACHE_KEY) ?? "{}") as Record<string, CachedTurnActivity>;
    const entry = entries[sessionId];
    return entry?.sessionId === sessionId ? entry : undefined;
  } catch {
    return undefined;
  }
}

export function writeCachedTurnActivity(storage: ClientStorage, activity: CachedTurnActivity): void {
  try {
    const entries = JSON.parse(storage.get(TURN_ACTIVITY_CACHE_KEY) ?? "{}") as Record<string, CachedTurnActivity>;
    delete entries[activity.sessionId];
    entries[activity.sessionId] = { ...activity, tools: boundedTools(activity.tools) };
    const recent = Object.fromEntries(Object.entries(entries).slice(-12));
    storage.set(TURN_ACTIVITY_CACHE_KEY, JSON.stringify(recent));
  } catch {
    // A full storage area must not break the transcript.
  }
}

/** Drops a thread's cached turn, so a run that died leaves no ghost activity behind. */
export function clearCachedTurnActivity(storage: ClientStorage, sessionId: string): void {
  try {
    const entries = JSON.parse(storage.get(TURN_ACTIVITY_CACHE_KEY) ?? "{}") as Record<string, CachedTurnActivity>;
    if (!(sessionId in entries)) return;
    delete entries[sessionId];
    storage.set(TURN_ACTIVITY_CACHE_KEY, JSON.stringify(entries));
  } catch {
    // A full or blocked storage area must not break recovery.
  }
}

/**
 * The restored live work, unless it belongs to a turn before the last prompt.
 * A detail names the last turn that used tools, and the cache the last one on
 * screen; drawn as live work, that turn's tools would move below the new
 * prompt and take its fold with them.
 */
export function activityOfLatestTurn<T extends { tools: readonly UiToolRun[]; anchorMessageId?: string }>(
  activity: T | undefined,
  messages: readonly UiMessage[],
  history: readonly UiTurnActivityEntry[] = [],
): T | undefined {
  if (!activity) return undefined;
  let lastPrompt = messages.length - 1;
  while (lastPrompt >= 0 && messages[lastPrompt].role !== "user") lastPrompt -= 1;
  if (lastPrompt <= 0) return activity;
  const earlier = new Set<string>();
  for (const message of messages.slice(0, lastPrompt)) {
    earlier.add(message.id);
    if (message.sourceEntryId) earlier.add(message.sourceEntryId);
  }
  const before = (id: string | undefined) => id !== undefined && earlier.has(id);
  if (before(activity.anchorMessageId)) return undefined;
  const ids = new Set(activity.tools.map((tool) => tool.id));
  const settled = history.some((entry) => before(entry.anchorMessageId) && entry.tools.some((tool) => ids.has(tool.id)));
  return settled ? undefined : activity;
}

/** Net worktree changes made after an agent run began. */
function pathFromTool(tool: UiToolRun): string | undefined {
  if (!/^(?:edit|write)$/u.test(tool.name)) return undefined;
  const value = tool.args.path ?? tool.args.file_path;
  return typeof value === "string" ? value.replaceAll("\\", "/") : undefined;
}

export function changesTouchedByTools(tools: readonly UiToolRun[], current: UiWorkspaceChanges): UiWorkspaceChanges {
  const paths = tools.map(pathFromTool).filter((path): path is string => Boolean(path));
  const files = current.files.filter((file) => paths.some((path) => path === file.path || path.endsWith(`/${file.path}`)));
  return {
    files,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
  };
}

export function changesSinceTurn(
  baseline: UiWorkspaceChanges | undefined,
  current: UiWorkspaceChanges,
): UiWorkspaceChanges {
  if (!baseline) return { branch: current.branch, files: [], added: 0, removed: 0 };
  const beforeByPath = new Map(baseline.files.map((file) => [file.path, file]));
  const files = current.files.flatMap((file) => {
    const before = beforeByPath.get(file.path);
    if (before && before.status === file.status && before.added === file.added && before.removed === file.removed) return [];
    if (!before) return [{ ...file }];
    const addedDelta = file.added - before.added;
    const removedDelta = file.removed - before.removed;
    return [{
      ...file,
      added: Math.max(0, addedDelta) + Math.max(0, -removedDelta),
      removed: Math.max(0, removedDelta) + Math.max(0, -addedDelta),
    }];
  });
  return {
    branch: current.branch,
    refreshStatus: current.refreshStatus,
    files,
    added: files.reduce((total, file) => total + file.added, 0),
    removed: files.reduce((total, file) => total + file.removed, 0),
  };
}

/** What `followTurnActivity` reads of the thread view; `ThreadViewStore` is one. */
export interface TurnActivitySource {
  getSnapshot(): { sessionId: string } | undefined;
  getToolView(): { tools: readonly UiToolRun[]; toolAnchorId?: string; turnActivitySessionId?: string };
  subscribeToSnapshot(listener: () => void): () => void;
  subscribeToTools(listener: () => void): () => void;
}

/**
 * Writes the visible thread's live turn to the cache whenever it changes. It
 * listens to the store, not a render, so tool output re-renders nothing here.
 */
export function followTurnActivity(source: TurnActivitySource, storage: ClientStorage): () => void {
  let written: { sessionId?: string; tools?: readonly UiToolRun[]; anchorMessageId?: string } = {};
  const write = () => {
    const sessionId = source.getSnapshot()?.sessionId;
    const { tools, toolAnchorId, turnActivitySessionId } = source.getToolView();
    if (!sessionId || turnActivitySessionId !== sessionId) return;
    if (written.sessionId === sessionId && written.tools === tools && written.anchorMessageId === toolAnchorId) return;
    written = { sessionId, tools, anchorMessageId: toolAnchorId };
    writeCachedTurnActivity(storage, { sessionId, tools: [...tools], anchorMessageId: toolAnchorId });
  };
  write();
  const stopTools = source.subscribeToTools(write);
  const stopSnapshot = source.subscribeToSnapshot(write);
  return () => { stopTools(); stopSnapshot(); };
}
