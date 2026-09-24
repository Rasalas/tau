import type { PaletteItem, PaletteSearchContext } from "tau";
import type { ThreadMatch } from "./protocol.js";

/**
 * What the kit adds to the palette: threads by title, threads by what was said
 * in them, and projects. Pure over the index the palette hands in.
 */

const THREAD_ROWS = 8;
const PROJECT_ROWS = 6;

export function paletteTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/u).filter(Boolean);
}

function holdsAll(tokens: readonly string[], ...fields: Array<string | undefined>): boolean {
  const haystack = fields.filter(Boolean).join(" ").toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

function onScreen(context: PaletteSearchContext, id: string): string {
  return context.index.activeThreadId === id ? " · on screen" : "";
}

export function threadTitleItems(query: string, context: PaletteSearchContext): PaletteItem[] {
  const tokens = paletteTokens(query);
  if (tokens.length === 0) return [];
  return context.index.threads
    .filter((thread) => holdsAll(tokens, thread.title, thread.projectName))
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .slice(0, THREAD_ROWS)
    .map((thread) => ({
      id: thread.id,
      label: thread.title || "Untitled thread",
      detail: `${thread.projectName}${onScreen(context, thread.id)}`,
      access: "read",
      run: (actions) => { void actions.switchSession(thread.path); },
    }));
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
    items.push({
      id: thread.id,
      label: thread.title || "Untitled thread",
      detail: match.snippet,
      access: "read",
      run: (actions) => { void actions.switchSession(thread.path); },
    });
  }
  return items;
}

/** Resolves after `ms`, or at once when the query moved on. */
export function settle(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
