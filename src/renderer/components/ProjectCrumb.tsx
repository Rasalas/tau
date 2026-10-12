import { useSyncExternalStore } from "react";
import { findProjectForSession } from "../../shared/session-project";
import { useThreadStore } from "../workbench-context";
import { ProjectIcon } from "./ProjectIcon";
import { tooltipProps } from "./ui/Tooltip";

/**
 * The project the thread on screen lives in, leading the head's crumbs; it
 * starts a new thread there, as T3 Code's head does. A worktree's thread
 * names the project it belongs to.
 */
export function ProjectCrumb({ sessionId, onNewThread }: { sessionId: string | undefined; onNewThread(workspace: string): void }) {
  const store = useThreadStore();
  const index = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const projects = useSyncExternalStore(store.subscribeToProjects, store.getProjects);
  const session = sessionId ? index.threads.find((thread) => thread.id === sessionId) : undefined;
  if (!session?.projectPath) return null;
  const owner = findProjectForSession(projects, session);
  const name = owner?.name ?? session.projectName;
  if (!name) return null;
  const label = `New thread in ${name}`;
  return <>
    <button type="button" className="thread-crumb-project" aria-label={label} {...tooltipProps(label, { side: "bottom" })}
      onClick={() => onNewThread(owner?.path ?? session.projectPath)}
    >
      <ProjectIcon project={{ path: session.projectPath, name: session.projectName, workspaceId: session.workspaceId }} />
      <span>{name}</span>
    </button>
    <span className="thread-crumb-separator" aria-hidden>/</span>
  </>;
}
