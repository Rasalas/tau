import { createElement } from "react";
import { File } from "lucide-react";
import { ProjectIcon, type PaletteItem, type PaletteSearchContext, type UiSession } from "tau";
import type { FileMatch, ThreadMatch } from "./protocol.js";

/**
 * What the kit adds to the palette: threads by title, threads by what was said
 * in them, and projects. Pure over the index the palette hands in.
 */

const THREAD_ROWS = 8;
/** Recent threads All shows before anything is typed; the Threads tab shows more. */
const RECENT_ROWS = 5;
const SCOPED_ROWS = 60;
const PROJECT_ROWS = 6;

export function paletteTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/u).filter(Boolean);
}

function holdsAll(tokens: readonly string[], ...fields: Array<string | undefined>): boolean {
  const haystack = fields.filter(Boolean).join(" ").toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

/** `now`, `5m`, `3h`, `2d`: how long ago the thread last moved. */
export function threadAge(modifiedAt: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - modifiedAt) / 60000));
  return minutes < 1 ? "now" : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}

/** Project, then "working" or its age, then its branch: design 2b's line. */
function threadItem(thread: UiSession, context: PaletteSearchContext, detail?: string): PaletteItem {
  const project = context.index.projects.find((entry) => (thread.workspaceId && entry.workspaceId === thread.workspaceId) || entry.path === thread.projectPath)
    ?? { path: thread.projectPath, name: thread.projectName };
  const state = context.index.running?.includes(thread.id) ? "working" : threadAge(thread.modifiedAt);
  return {
    id: thread.id,
    label: thread.title || "Untitled thread",
    detail: detail ?? [thread.projectName, state, thread.projectLabel].filter(Boolean).join(" · "),
    icon: createElement(ProjectIcon, { project }),
    access: "read",
    run: (actions) => { void actions.switchSession(thread.path); },
    stage: (actions) => actions.openThread(thread.id),
  };
}

export function threadTitleItems(query: string, context: PaletteSearchContext): PaletteItem[] {
  const tokens = paletteTokens(query);
  if (tokens.length === 0 && !context.scope) return [];
  return context.index.threads
    // Before anything is typed, agents stay in their panel as they do in the rail.
    .filter((thread) => (tokens.length || !thread.parentThreadId) && holdsAll(tokens, thread.title, thread.projectName))
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .slice(0, context.scope === "threads" ? SCOPED_ROWS : tokens.length ? THREAD_ROWS : RECENT_ROWS)
    .map((thread) => threadItem(thread, context));
}

export function projectItems(query: string, context: PaletteSearchContext): PaletteItem[] {
  const tokens = paletteTokens(query);
  if (tokens.length === 0) return [];
  return context.index.projects
    .filter((project) => holdsAll(tokens, project.name, project.displayPath ?? project.path))
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .slice(0, PROJECT_ROWS)
    .map((project) => ({
      id: project.workspaceId ?? project.path,
      label: project.name,
      detail: project.displayPath ?? project.path,
      // Opening a project adds it to the host's list.
      access: "write",
      run: (actions) => { void actions.openWorkspace(project.workspaceId ?? project.path); },
    }));
}

/** A thread the host found by its text, unless the title already put it on the list. */
export function threadContentItems(matches: readonly ThreadMatch[], context: PaletteSearchContext, shown: ReadonlySet<string>): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const match of matches) {
    const thread = context.index.threads.find((entry) => entry.id === match.sessionId || (match.path && entry.path === match.path));
    if (!thread || shown.has(thread.id) || items.some((item) => item.id === thread.id)) continue;
    items.push(threadItem(thread, context, match.snippet));
  }
  return items;
}

/** A file of the project on screen: its folder and, when Git has it changed, its status letter. */
export function fileItems(files: readonly FileMatch[], status: ReadonlyMap<string, string>): PaletteItem[] {
  return files.map(({ path }) => {
    const slash = path.lastIndexOf("/");
    const letter = status.get(path);
    return {
      id: path,
      label: path.slice(slash + 1),
      detail: [path.slice(0, Math.max(0, slash)), letter].filter(Boolean).join(" · "),
      icon: createElement(File, { size: 13 }),
      access: "read",
      run: (actions) => actions.openFile(path),
      stage: (actions) => actions.openFile(path, { pin: true }),
    };
  });
}

/** Resolves after `ms`, or at once when the query moved on. */
export function settle(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
