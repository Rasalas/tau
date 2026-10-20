import { findProjectForSession, type ClientStorage, type UiProject, type UiSession } from "tau";

/** Undefined shows every project; an empty list deliberately shows none. Strings are the old name-based API. */
export type RailProjectFilter = readonly string[] | string | undefined;
export interface SavedProjectGroup { id: string; name: string; projects: readonly string[] }
export interface RailProjectState { filter?: RailProjectFilter; groups: readonly SavedProjectGroup[] }

export const NO_PROJECT = "@no-project";
export const PROJECT_FILTER_KEY = "host:tau.workspace.project-filter.v1";
export const projectId = (project: UiProject): string => project.workspaceId ?? project.path;
export const sameProjects = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((id) => right.includes(id));

export function selectedProjects(filter: RailProjectFilter, projects: readonly UiProject[]): readonly string[] | undefined {
  return typeof filter === "string" ? projects.filter((project) => project.name === filter).map(projectId) : filter;
}

type ProjectThread = Pick<UiSession, "projectPath" | "projectName" | "workspaceId" | "projectless">;
export function projectFilterIncludes(filter: RailProjectFilter, thread: ProjectThread, projects: readonly UiProject[]): boolean {
  if (filter === undefined) return true;
  if (typeof filter === "string") return thread.projectName === filter;
  if (thread.projectless) return filter.includes(NO_PROJECT);
  if (thread.workspaceId && filter.includes(thread.workspaceId)) return true;
  // An id from another machine must never match this machine's same-named project.
  const project = thread.workspaceId
    ? projects.find((candidate) => candidate.workspaceId === thread.workspaceId)
    : findProjectForSession(projects, thread);
  return project !== undefined && (filter.includes(projectId(project)) || filter.includes(project.path));
}

export function matchingGroup(filter: RailProjectFilter, groups: readonly SavedProjectGroup[], projects: readonly UiProject[]): SavedProjectGroup | undefined {
  const ids = selectedProjects(filter, projects);
  return ids?.length ? groups.find((group) => sameProjects(group.projects, ids)) : undefined;
}

export function projectFilterLabel(filter: RailProjectFilter, groups: readonly SavedProjectGroup[], projects: readonly UiProject[]): string {
  const ids = selectedProjects(filter, projects);
  if (ids === undefined) return "All projects";
  if (!ids.length) return "None selected";
  const group = matchingGroup(filter, groups, projects);
  if (group) return group.name;
  if (ids.length > 1) return `${ids.length} projects`;
  return projectName(ids[0]!, projects);
}

export function projectName(id: string, projects: readonly UiProject[]): string {
  return id === NO_PROJECT ? "No project" : projects.find((project) => projectId(project) === id || project.path === id)?.name ?? "Unavailable project";
}

function readIds(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((id) => typeof id === "string" && id.length > 0) ? [...new Set(value)] : undefined;
}

export function readProjectFilter(storage: ClientStorage | undefined): RailProjectState {
  try {
    const value: unknown = JSON.parse(storage?.get(PROJECT_FILTER_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return { groups: [] };
    const raw = value as Record<string, unknown>;
    const filter = typeof raw.filter === "string" ? raw.filter : readIds(raw.filter);
    const groups: SavedProjectGroup[] = [];
    if (Array.isArray(raw.groups)) for (const item of raw.groups) {
      if (!item || typeof item !== "object") continue;
      const projects = readIds(item.projects);
      if (typeof item.id !== "string" || !item.id || typeof item.name !== "string" || !item.name.trim() || !projects?.length || groups.some((group) => group.id === item.id)) continue;
      groups.push({ id: item.id, name: item.name.trim(), projects });
    }
    return { filter, groups };
  } catch { return { groups: [] }; }
}

export function writeProjectFilter(storage: ClientStorage | undefined, state: RailProjectState): void {
  storage?.set(PROJECT_FILTER_KEY, JSON.stringify(state));
}
