import type { UiToolRun } from "../shared/contracts";
import type { UiChangedFile, UiWorkspaceChanges } from "../shared/workspace-kit-types";

const TURN_ACTIVITY_CACHE_KEY = "tau.turn-activity.v1";

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

export function readCachedTurnActivity(storage: Storage, sessionId: string): CachedTurnActivity | undefined {
  try {
    const entries = JSON.parse(storage.getItem(TURN_ACTIVITY_CACHE_KEY) ?? "{}") as Record<string, CachedTurnActivity>;
    const entry = entries[sessionId];
    return entry?.sessionId === sessionId ? entry : undefined;
  } catch {
    return undefined;
  }
}

export function writeCachedTurnActivity(storage: Storage, activity: CachedTurnActivity): void {
  try {
    const entries = JSON.parse(storage.getItem(TURN_ACTIVITY_CACHE_KEY) ?? "{}") as Record<string, CachedTurnActivity>;
    delete entries[activity.sessionId];
    entries[activity.sessionId] = { ...activity, tools: boundedTools(activity.tools) };
    const recent = Object.fromEntries(Object.entries(entries).slice(-12));
    storage.setItem(TURN_ACTIVITY_CACHE_KEY, JSON.stringify(recent));
  } catch {
    // A full storage area must not break the transcript.
  }
}

/** Drops a thread's cached turn, so a run that died leaves no ghost activity behind. */
export function clearCachedTurnActivity(storage: Storage, sessionId: string): void {
  try {
    const entries = JSON.parse(storage.getItem(TURN_ACTIVITY_CACHE_KEY) ?? "{}") as Record<string, CachedTurnActivity>;
    if (!(sessionId in entries)) return;
    delete entries[sessionId];
    storage.setItem(TURN_ACTIVITY_CACHE_KEY, JSON.stringify(entries));
  } catch {
    // A full or blocked storage area must not break recovery.
  }
}

/** Net worktree changes made after an agent run began. */
function pathFromTool(tool: UiToolRun): string | undefined {
  if (!/^(?:edit|write)$/u.test(tool.name)) return undefined;
  const value = tool.args.path ?? tool.args.file_path;
  return typeof value === "string" ? value.replaceAll("\\", "/") : undefined;
}

export function changesTouchedByTools(tools: UiToolRun[], current: UiWorkspaceChanges): UiWorkspaceChanges {
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
