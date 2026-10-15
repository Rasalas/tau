import { useContext, useMemo, useState, useSyncExternalStore, type CSSProperties } from "react";
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
function useResolvedIcon(project: IconSubject | undefined, fallback?: string): { images: readonly string[]; owner: UiProject | undefined } {
  const registry = useContext(WorkbenchShellContext)?.registry;
  const store = useContext(ThreadStoreContext);
  const projects = useSyncExternalStore(store?.subscribeToProjects ?? noSubscribe, store?.getProjects ?? getNoProjects);
  const owner = project ? findProjectForSession(projects, { projectPath: project.path, workspaceId: project.workspaceId, projectName: project.name }) : undefined;
  const chosen = useSyncExternalStore(registry?.subscribeProjectIcons ?? noSubscribe, () =>
    (project ? registry?.projectIcon(project) : undefined) ?? (owner ? registry?.projectIcon(owner) : undefined));
  const images = useMemo(() => [...new Set([chosen, fallback, project?.icon, owner?.icon].filter((image): image is string => Boolean(image)))],
    [chosen, fallback, project?.icon, owner?.icon, project?.path, project?.workspaceId]);
  return { images, owner };
}

/** A published or saved picture for the project, else the host's. */
export function useProjectIcon(project: IconSubject | undefined): string | undefined {
  return useResolvedIcon(project).images[0];
}

/**
 * A project's mark wherever one is drawn: a published or saved picture, else
 * the host's, else its initial on its hue. A worktree's thread draws its
 * project's mark. `icon` is a caller's own fallback.
 */
export function ProjectIcon({ project, icon, hue, className }: {
  project: ProjectIconSubject;
  icon?: string | undefined;
  /** What the tint is hashed from; the owning project's path by default. */
  hue?: string | undefined;
  className?: string | undefined;
}) {
  const { images, owner } = useResolvedIcon(project, icon);
  const [failures, setFailures] = useState<{ images: readonly string[]; failed: readonly string[] }>({ images, failed: [] });
  // A new source or project gets a fresh attempt, without sharing failures with other marks.
  const failed = failures.images === images ? failures.failed : [];
  const image = images.find((candidate) => !failed.includes(candidate));
  return <i
    className={`thread-project-icon${className ? ` ${className}` : ""}${image ? " has-image" : ""}`}
    style={{ "--project-hue": projectHue(hue ?? owner?.path ?? project.path) } as CSSProperties}
    aria-hidden="true"
  >{image ? <img key={image} src={image} alt="" onError={() => setFailures({ images, failed: [...failed, image] })} /> : projectInitial(owner?.name ?? project.name)}</i>;
}
