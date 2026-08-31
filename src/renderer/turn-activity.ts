import type { UiChangedFile, UiToolRun, UiWorkspaceChanges } from "../shared/contracts";
import { changesSinceTurn as changesSinceTurnShared } from "../shared/turn-checkpoints";

const TURN_ACTIVITY_CACHE_KEY = "tau.turn-activity.v1";

export interface CachedTurnActivity {
  sessionId: string;
  baseline: UiWorkspaceChanges;
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
  return changesSinceTurnShared(baseline, current);
}
