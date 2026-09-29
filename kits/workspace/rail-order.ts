import type { PreferencesStore, UiProject, UiSession } from "tau";
import { WORKSPACE_HOST_EXTENSION_ID } from "./protocol.js";

/** Flat, or grouped by repository (with its worktrees), by project folder, or by checkout. */
export type RailGrouping = "none" | "repository" | "repository_path" | "separate";
/** Groups by their newest thread, by when the project was last opened, or by name. */
export type RailProjectSort = "activity" | "opened" | "name";
export type RailThreadSort = "updated" | "created";

export interface RailOrder {
  grouping: RailGrouping;
  projectSort: RailProjectSort;
  threadSort: RailThreadSort;
  /** Threads a group shows before its "show more". */
  preview: number;
}

export const RAIL_GROUPING_OPTION = "rail-grouping";
export const RAIL_PROJECT_SORT_OPTION = "rail-project-sort";
export const RAIL_THREAD_SORT_OPTION = "rail-thread-sort";
export const RAIL_PREVIEW_OPTION = "rail-preview";
/** The toggle the grouping replaced; a user who had it on keeps grouping by repository. */
export const LEGACY_GROUP_OPTION = "group-by-project";

export const DEFAULT_PREVIEW = 6;
/** 1 to 15. */
export const PREVIEW_CHOICES = Array.from({ length: 15 }, (_, index) => index + 1);

export const RAIL_ORDER_OPTIONS = [
  {
    id: RAIL_GROUPING_OPTION,
    kind: "select" as const,
    label: "Group threads in the rail",
    values: [
      { value: "none", label: "Don't group" },
      { value: "repository", label: "By repository" },
      { value: "repository_path", label: "By repository path" },
      { value: "separate", label: "By checkout" },
    ],
    defaultValue: "none",
  },
  {
    id: RAIL_PROJECT_SORT_OPTION,
    kind: "select" as const,
    label: "Order groups by",
    values: [{ value: "activity", label: "Latest thread" }, { value: "opened", label: "Last opened" }, { value: "name", label: "Name" }],
    defaultValue: "activity",
  },
  {
    id: RAIL_THREAD_SORT_OPTION,
    kind: "select" as const,
    label: "Order threads by",
    values: [{ value: "updated", label: "Last activity" }, { value: "created", label: "Created" }],
    defaultValue: "updated",
  },
  {
    id: RAIL_PREVIEW_OPTION,
    kind: "select" as const,
    label: "Threads per group before “show more”",
    values: PREVIEW_CHOICES.map((count) => ({ value: String(count), label: String(count) })),
    defaultValue: String(DEFAULT_PREVIEW),
  },
];

const oneOf = <T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined =>
  allowed.includes(value as T) ? value as T : undefined;

export function readRailOrder(preferences: Pick<PreferencesStore, "value" | "optionValue">): RailOrder {
  const id = WORKSPACE_HOST_EXTENSION_ID;
  const legacy = preferences.optionValue(id, LEGACY_GROUP_OPTION, false) ? "repository" : "none";
  const preview = Number(preferences.value(id, RAIL_PREVIEW_OPTION));
  return {
    grouping: oneOf(preferences.value(id, RAIL_GROUPING_OPTION), ["none", "repository", "repository_path", "separate"]) ?? legacy,
    projectSort: oneOf(preferences.value(id, RAIL_PROJECT_SORT_OPTION), ["activity", "opened", "name"]) ?? "activity",
    threadSort: oneOf(preferences.value(id, RAIL_THREAD_SORT_OPTION), ["updated", "created"]) ?? "updated",
    preview: PREVIEW_CHOICES.includes(preview) ? preview : DEFAULT_PREVIEW,
  };
}

/** A thread the index knows no creation time for sorts by its last activity. */
export function sortThreads(threads: readonly UiSession[], sort: RailThreadSort): UiSession[] {
  const key = sort === "created" ? (session: UiSession) => session.createdAt ?? session.modifiedAt : (session: UiSession) => session.modifiedAt;
  return threads.slice().sort((left, right) => key(right) - key(left));
}

const lastSegment = (path: string) => path.replace(/\/+$/u, "").split("/").pop() || path;

export interface RailGroup {
  key: string;
  label: string;
  threads: UiSession[];
}

/** The group a thread falls in and what its heading says. */
export function groupOf(session: UiSession, grouping: RailGrouping, project: UiProject | undefined): { key: string; label: string } {
  if (grouping === "separate") {
    const checkout = session.projectDisplayPath ?? session.projectPath;
    const folder = lastSegment(checkout);
    return { key: `checkout:${session.workspaceId ?? session.projectPath}`, label: folder === session.projectName ? folder : `${session.projectName} · ${folder}` };
  }
  if (grouping === "repository_path" && project) {
    const folder = lastSegment(project.displayPath ?? project.path);
    return { key: `project:${project.workspaceId ?? project.path}`, label: folder === project.name ? project.name : `${project.name} · ${folder}` };
  }
  // Worktrees and project folders of one repository carry its name (Workspace Kit names projects so).
  return { key: `repository:${session.projectName}`, label: session.projectName };
}

/** The main list in groups; each group keeps the order its threads came in. */
export function groupThreads(
  threads: readonly UiSession[],
  grouping: Exclude<RailGrouping, "none">,
  projectSort: RailProjectSort,
  projectOf: (session: UiSession) => UiProject | undefined,
): RailGroup[] {
  const groups = new Map<string, RailGroup & { opened: number; active: number }>();
  for (const session of threads) {
    const project = projectOf(session);
    const { key, label } = groupOf(session, grouping, project);
    const group = groups.get(key);
    if (group) {
      group.threads.push(session);
      group.opened = Math.max(group.opened, project?.lastOpenedAt ?? 0);
      group.active = Math.max(group.active, session.modifiedAt);
    } else {
      groups.set(key, { key, label, threads: [session], opened: project?.lastOpenedAt ?? 0, active: session.modifiedAt });
    }
  }
  const list = [...groups.values()];
  if (projectSort === "name") list.sort((left, right) => left.label.localeCompare(right.label));
  else if (projectSort === "opened") list.sort((left, right) => right.opened - left.opened);
  // By the newest activity in the group, whatever order its threads are in.
  else list.sort((left, right) => right.active - left.active);
  return list.map(({ key, label, threads: grouped }) => ({ key, label, threads: grouped }));
}
