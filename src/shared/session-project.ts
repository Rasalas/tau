import type { UiProject, UiSession } from "./contracts.js";

/** Match a thread to its project, including a worktree outside the root folder. */
export function findProjectForSession(
  projects: readonly UiProject[],
  session: Pick<UiSession, "projectPath"> & Partial<Pick<UiSession, "projectName" | "workspaceId">>,
): UiProject | undefined {
  if (!projects.length) return undefined;
  if (session.workspaceId) {
    const byWorkspace = projects.find((project) => project.workspaceId === session.workspaceId);
    if (byWorkspace) return byWorkspace;
  }

  const byPath = projects.find((project) => project.path === session.projectPath);
  if (byPath) return byPath;

  // Deepest first; a folder that merely contains the thread ("/", a home folder) loses to the repository's name.
  const containing = projects.filter((project) => {
    const prefix = project.path.endsWith("/") ? project.path : `${project.path}/`;
    return session.projectPath.startsWith(prefix);
  }).sort((a, b) => b.path.length - a.path.length);
  const sameName = containing.find((project) => project.name === session.projectName);
  if (sameName) return sameName;

  if (session.projectName) {
    const byName = projects.filter((project) => project.name === session.projectName);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      const bySharedDir = byName.find((project) => {
        const parentDir = project.path.slice(0, project.path.lastIndexOf("/"));
        return Boolean(parentDir && session.projectPath.startsWith(parentDir));
      });
      return bySharedDir ?? byName[0];
    }
  }

  return containing[0];
}
