import { createElement } from "react";
import { File } from "lucide-react";
import { ProjectIcon, type PaletteItem, type PaletteSearchContext, type UiSession } from "tau";
import type { FileMatch, ThreadMatch, ThreadRequestMatch } from "./protocol.js";
import { threadRank } from "./relevance.js";

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

/** Project, then "working", "waiting" or its age, then its branch: design 2b's line. */
function threadItem(thread: UiSession, context: PaletteSearchContext, detail?: string): PaletteItem {
  const project = context.index.projects.find((entry) => thread.workspaceId ? entry.workspaceId === thread.workspaceId : entry.path === thread.projectPath)
    ?? { path: thread.projectPath, name: thread.projectName };
  const state = context.index.waiting?.includes(thread.id) ? "waiting" : context.index.running?.includes(thread.id) ? "working" : threadAge(thread.modifiedAt);
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

/** `parentThreadId` denotes delegation, not a fork. Those threads belong in lineage, as in the rail. */
export function paletteThreads(context: PaletteSearchContext): readonly UiSession[] {
  return context.index.threads.filter((thread) => !thread.parentThreadId
    && (thread.messageCount > 0 || context.index.running?.includes(thread.id) || context.index.waiting?.includes(thread.id)));
}

export function threadTitleItems(query: string, context: PaletteSearchContext): PaletteItem[] {
  const tokens = paletteTokens(query);
  if (tokens.length === 0 && !context.scope) return [];
  const waiting = new Set(tokens.length ? [] : context.index.waiting);
  const archived = new Set(context.index.archivedThreadIds);
  const matching = paletteThreads(context)
    .map((thread) => ({ thread, rank: threadRank(tokens, thread.title, thread.projectLabel, thread.projectName) }))
    .filter(({ rank }) => !tokens.length || rank > 0)
    // Before anything is typed, threads waiting on the user come first, however old.
    .sort((a, b) => Number(archived.has(a.thread.id)) - Number(archived.has(b.thread.id)) || Number(waiting.has(b.thread.id)) - Number(waiting.has(a.thread.id)) || b.rank - a.rank || b.thread.modifiedAt - a.thread.modifiedAt);
  const asking = matching.filter(({ thread }) => waiting.has(thread.id)).length;
  const rows = context.scope === "threads" ? SCOPED_ROWS : tokens.length ? THREAD_ROWS : Math.max(RECENT_ROWS, asking);
  return matching.slice(0, rows).map(({ thread }) => threadItem(thread, context, archived.has(thread.id) ? "Archived" : undefined));
}

/** "#95 · acme/tau · open" ("!95" for a GitLab merge request) for a thread's first matching request, "+N" for more. */
function requestDetail(match: ThreadRequestMatch): string {
  const [first] = match.requests;
  if (!first) return "";
  return [`${/\/-\/merge_requests\/|\/pullrequest\//u.test(first.url) ? "!" : "#"}${first.number}`, first.repository, first.state, first.headBranch, match.requests.length > 1 ? `+${match.requests.length - 1}` : undefined].filter(Boolean).join(" · ");
}

/** Threads whose pull or merge request the query names, unless the title already put them on the list. */
export function threadRequestItems(matches: readonly ThreadRequestMatch[], context: PaletteSearchContext, shown: ReadonlySet<string>): PaletteItem[] {
  const threads = new Map(paletteThreads(context).map((thread) => [thread.id, thread]));
  return matches
    .flatMap((match) => {
      const thread = threads.get(match.sessionId);
      return thread && !shown.has(thread.id) ? [{ thread, match }] : [];
    })
    .sort((a, b) => b.thread.modifiedAt - a.thread.modifiedAt)
    .slice(0, THREAD_ROWS)
    .map(({ thread, match }) => threadItem(thread, context, requestDetail(match)));
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
export function threadContentItems(matches: readonly ThreadMatch[], context: PaletteSearchContext, shown: ReadonlySet<string>, query = ""): PaletteItem[] {
  const items: PaletteItem[] = [];
  const threads = new Map(paletteThreads(context).map((thread) => [thread.id, thread]));
  for (const match of matches) {
    // A path can name a different thread on another machine. Only the host's
    // thread identity can join content to the workbench index.
    const thread = threads.get(match.sessionId);
    if (!thread || shown.has(thread.id) || items.some((item) => item.id === thread.id)) continue;
    const archived = context.index.archivedThreadIds?.includes(thread.id);
    const speaker = match.role === "user" ? "You" : "Agent";
    const item = threadItem(thread, context, `${speaker}: ${match.snippet}${archived ? " · Archived" : ""}`);
    item.ariaLabel = `${item.label}, ${speaker} said: ${match.snippet}${archived ? ", Archived" : ""}`;
    item.detailContent = createElement("span", null, `${speaker}: `, highlightedSnippet(match.snippet, query), archived ? " · Archived" : "");
    item.run = async actions => {
      if (await actions.switchSession(thread.path)) actions.findInThread?.(query, { sessionId: thread.id, mode: "all-words" });
    };
    items.push(item);
  }
  return items;
}

/** React escapes all transcript text; only literal matched words become marks. */
export function highlightedSnippet(snippet: string, query: string) {
  const tokens = paletteTokens(query).sort((a, b) => b.length - a.length);
  if (!tokens.length) return snippet;
  const pattern = new RegExp(`(${tokens.map(token => token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|")})`, "giu");
  return snippet.split(pattern).map((part, at) => at % 2 ? createElement("mark", { key: at }, part) : part);
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
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}
