import { paneIds, type TerminalGroup, type TerminalLayout } from "./layout.js";
import type { UiTerminalSession } from "./protocol.js";

/** Where a terminal sits relative to the thread on screen; the panel lists only the first two as tabs. */
export type TerminalPlace = "thread" | "project" | "elsewhere";

export function placeOf(session: UiTerminalSession, activeSessionId: string | undefined): TerminalPlace {
  if (!session.sessionId) return "project";
  return session.sessionId === activeSessionId ? "thread" : "elsewhere";
}

/**
 * A panel tab belongs where its first shell does. One the host has not listed
 * yet was just opened here, so it counts as this thread's.
 */
export function groupPlace(group: TerminalGroup, sessions: readonly UiTerminalSession[], activeSessionId: string | undefined): TerminalPlace {
  const first = sessions.find((session) => session.id === paneIds(group.root)[0]);
  return first ? placeOf(first, activeSessionId) : "thread";
}

/** The panel as the thread on screen sees it: its own and the project's tabs, and the other threads' kept aside. */
export interface ThreadScope {
  /** Tabs of this thread and of the project, in layout order. */
  shown: TerminalGroup[];
  /** Tabs another thread opened; they keep running there. */
  elsewhere: TerminalGroup[];
  /** The tab the panel shows: the active one if shown (or picked from `elsewhere`), else the last shown. */
  current?: TerminalGroup;
  /** Shells of this thread or the project in stage tabs. */
  staged: number;
}

export function threadScope(
  layout: TerminalLayout,
  sessions: readonly UiTerminalSession[],
  activeSessionId: string | undefined,
  /** A tab of another thread the user asked to see here. */
  picked?: string,
): ThreadScope {
  const shown: TerminalGroup[] = [];
  const elsewhere: TerminalGroup[] = [];
  for (const group of layout.groups) {
    if (groupPlace(group, sessions, activeSessionId) === "elsewhere" && group.id !== picked) elsewhere.push(group);
    else shown.push(group);
  }
  const active = shown.find((group) => group.id === layout.active);
  const current = active ?? shown.filter((group) => group.id !== picked).at(-1);
  const staged = layout.stage.filter((group) => groupPlace(group, sessions, activeSessionId) !== "elsewhere").length;
  return { shown, elsewhere, ...(current ? { current } : {}), staged };
}

/** Pressing the terminal button starts a shell only when this thread has none to show, in the panel or on the stage. */
export function needsFirstShell(scope: ThreadScope): boolean {
  return scope.shown.length === 0 && scope.staged === 0;
}
