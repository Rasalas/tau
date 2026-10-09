import type { HostBootstrap, HostSnapshot, UiProject, UiSession } from "../shared/contracts";
import { isFilesystemRoot } from "../shared/filesystem-root";
import { namesWorkspace } from "../shared/workspace-identity";
import type { NewThreadDraft } from "./draft-store";
import type { NewThreadSelection } from "./new-thread-controller";
import { inProject } from "./thread-supervision";

/** What is on screen when a new thread is asked for; `covered` when a page, Settings or a phone's list hides it. */
export interface NewThreadScreen {
  covered?: boolean;
  draft?: NewThreadDraft;
  /** The runtime the draft on screen is bound to. */
  draftRuntime?: string;
  thread?: Pick<HostSnapshot, "sessionId" | "cwd" | "workspaceId" | "backendKind" | "model" | "thinkingLevel" | "mode">;
}

/** The workspace of the draft or thread on screen; nothing when it is covered. */
export function workspaceOnScreen(screen: NewThreadScreen): string | undefined {
  if (screen.covered) return undefined;
  if (screen.draft) return screen.draft.workspaceId ?? screen.draft.projectPath;
  return screen.thread?.sessionId ? screen.thread.workspaceId ?? screen.thread.cwd : undefined;
}

/**
 * Where "New thread" opens a draft when no project was named: the project of
 * the draft or thread on screen, else `lastUsedProject`. Undefined means ask.
 */
export function newThreadProject(projects: readonly UiProject[], threads: readonly UiSession[], screen: NewThreadScreen): UiProject | undefined {
  const workspace = workspaceOnScreen(screen);
  const current = workspace ? projects.find((project) => namesWorkspace(workspace, project.workspaceId, project.path)) : undefined;
  return current ?? lastUsedProject(projects, threads);
}

/**
 * What a new draft takes from the draft or thread on screen:
 * the runtime with its model and level, and the mode. Access and the
 * workspace mode stay at their defaults.
 */
export function selectionOnScreen(screen: NewThreadScreen): NewThreadSelection | undefined {
  if (screen.covered) return undefined;
  const { draft, thread } = screen;
  if (draft) {
    const runtime = screen.draftRuntime ?? draft.runtime ?? "pi";
    const chosen = (draft.selectionRuntime ?? "pi") === runtime;
    return {
      runtime,
      ...(chosen && draft.model ? { model: draft.model } : {}),
      ...(chosen && draft.thinkingLevel ? { thinkingLevel: draft.thinkingLevel } : {}),
      ...(draft.mode ? { mode: draft.mode } : {}),
    };
  }
  if (!thread?.sessionId) return undefined;
  return {
    runtime: thread.backendKind ?? "pi",
    // A level is the model's; without one it says nothing.
    ...(thread.model ? { model: thread.model, ...(thread.thinkingLevel ? { thinkingLevel: thread.thinkingLevel } : {}) } : {}),
    ...(thread.mode ? { mode: thread.mode } : {}),
  };
}

/**
 * The project a new thread starts in when nobody named one: the one the
 * host's threads were last busy in, else the one it opened last. `/` never
 * counts; an app opened from the Finder once recorded it as a project.
 * Undefined means ask.
 */
export function lastUsedProject(projects: readonly UiProject[], threads: readonly UiSession[]): UiProject | undefined {
  const candidates = projects.filter((project) => !isFilesystemRoot(project.path));
  let best: { project: UiProject; at: number } | undefined;
  for (const project of candidates) {
    let at = project.lastOpenedAt;
    for (const thread of threads) {
      if (thread.messageCount > 0 && thread.modifiedAt > at && inProject(thread, project)) at = thread.modifiedAt;
    }
    if (!best || at > best.at) best = { project, at };
  }
  return best?.project;
}

/** The same projects with `/` moved to the end, so no list offers it first. */
export function rootLast<T extends Pick<UiProject, "path">>(projects: readonly T[]): T[] {
  return [...projects.filter((project) => !isFilesystemRoot(project.path)), ...projects.filter((project) => isFilesystemRoot(project.path))];
}

/**
 * The new thread's picker order: `first` (the project in
 * context), then by the last thread worked in or the last opening, `/` last.
 */
export function pickerOrder(projects: readonly UiProject[], threads: readonly Pick<UiSession, "workspaceId" | "projectPath" | "modifiedAt" | "messageCount">[], first?: string): UiProject[] {
  const at = new Map<string, number>();
  const touch = (key: string | undefined, time: number) => { if (key && (at.get(key) ?? 0) < time) at.set(key, time); };
  for (const thread of threads) if (thread.messageCount > 0) { touch(thread.workspaceId, thread.modifiedAt); touch(thread.projectPath, thread.modifiedAt); }
  const used = (project: UiProject) => Math.max(project.lastOpenedAt, at.get(project.workspaceId ?? "") ?? 0, at.get(project.path) ?? 0);
  const rank = (project: UiProject) => (first !== undefined && namesWorkspace(first, project.workspaceId, project.path) ? Infinity : used(project));
  return rootLast([...projects].sort((a, b) => rank(b) - rank(a)));
}

/**
 * The project whose draft replaces the empty thread the host opened at
 * startup, so the first screen is the one "New thread" opens. A thread the
 * index counts messages for stays.
 */
export function startDraftProject(bootstrap: Pick<HostBootstrap, "detail" | "project" | "threadIndex">, projects: readonly UiProject[]): UiProject | undefined {
  const { detail, project, threadIndex } = bootstrap;
  if (detail.messages.length > 0 || detail.isStreaming || detail.turnActivity?.tools.length) return undefined;
  if (threadIndex.sessions.some((session) => session.id === detail.sessionId && session.messageCount > 0)) return undefined;
  if (isFilesystemRoot(project.cwd)) return undefined;
  return projects.find((candidate) => namesWorkspace(project.workspaceId ?? project.cwd, candidate.workspaceId, candidate.path));
}
