import { useContext, useSyncExternalStore, type CSSProperties } from "react";
import { ThreadStoreContext, WorkbenchShellContext } from "../workbench-context";
import { findProjectForSession } from "../../shared/session-project";
import type { UiProject } from "../../shared/contracts";

export function projectHue(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

export function projectInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "·";
}

/** What a project's mark is drawn from; a `UiProject` is one. */
export interface ProjectIconSubject {
  path: string;
  name: string;
  workspaceId?: string | undefined;
  /** The host's picture (favicon, `t3.json`). */
  icon?: string | undefined;
}

const noSubscribe = () => () => undefined;
const noProjects: readonly UiProject[] = [];
const getNoProjects = () => noProjects;

type IconSubject = Pick<ProjectIconSubject, "path" | "workspaceId" | "icon"> & Partial<Pick<ProjectIconSubject, "name">>;

/** Resolve presentation against the project index even when the caller only has a thread's workspace. */
function useResolvedIcon(project: IconSubject | undefined, fallback?: string): string | undefined {
  const registry = useContext(WorkbenchShellContext)?.registry;
  const store = useContext(ThreadStoreContext);
  const projects = useSyncExternalStore(store?.subscribeToProjects ?? noSubscribe, store?.getProjects ?? getNoProjects);
  const owner = project ? findProjectForSession(projects, { projectPath: project.path, workspaceId: project.workspaceId, projectName: project.name }) : undefined;
  const chosen = useSyncExternalStore(registry?.subscribe ?? noSubscribe, () =>
    (project ? registry?.projectIcon(project) : undefined) ?? (owner ? registry?.projectIcon(owner) : undefined));
  return chosen ?? fallback ?? project?.icon ?? owner?.icon;
}

/** A kit's picture for the project (`setProjectIcons`), else the host's. */
export function useProjectIcon(project: IconSubject | undefined): string | undefined {
  return useResolvedIcon(project);
}

/**
 * A project's mark wherever one is drawn: the picture a kit chose, else the
 * host's, else its initial on its hue. `icon` is a caller's own fallback
 * (a navigator's match for a worktree's thread).
 */
export function ProjectIcon({ project, icon, hue, className }: {
  project: ProjectIconSubject;
  icon?: string | undefined;
  /** What the tint is hashed from; the path by default. */
  hue?: string | undefined;
  className?: string | undefined;
}) {
  const image = useResolvedIcon(project, icon);
  return <i
    className={`thread-project-icon${className ? ` ${className}` : ""}${image ? " has-image" : ""}`}
    style={{ "--project-hue": projectHue(hue ?? project.path) } as CSSProperties}
    aria-hidden="true"
  >{image ? <img src={image} alt="" /> : projectInitial(project.name)}</i>;
}
