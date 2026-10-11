import { useCallback, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { UiSession } from "../../shared/contracts";
import type { ThreadLinkTarget } from "../../shared/thread-links";
import { ThreadStoreContext, WorkbenchShellContext } from "../workbench-context";
import { ProjectIcon } from "./ProjectIcon";
import { tooltipProps } from "./ui/Tooltip";

const noSubscribe = () => () => undefined;

/**
 * A `tau://thread` link in a message: the thread's project mark and its current
 * title, so a rename reaches every message that links it. The label the message
 * wrote stands in only for a thread this window does not know. Click opens the
 * thread; with the modifier it opens in the stage beside the one on screen.
 */
export function ThreadLink({ target, children }: { target: ThreadLinkTarget; children?: ReactNode }) {
  const store = useContext(ThreadStoreContext);
  const actions = useContext(WorkbenchShellContext)?.actions;
  const { threadId } = target;
  const thread: UiSession | undefined = useSyncExternalStore(
    useCallback((listener: () => void) => store?.subscribeToThread(threadId, listener) ?? noSubscribe(), [store, threadId]),
    useCallback(() => store?.getThread(threadId), [store, threadId]),
  );
  if (!thread) return <span className="md-thread-link md-thread-link--gone" {...tooltipProps("Thread no longer available")}>{children}</span>;
  const title = thread.title.trim();
  const open = (event: { metaKey: boolean; ctrlKey: boolean }) => {
    if (!actions) return;
    if (event.metaKey || event.ctrlKey) actions.openThread(thread.id);
    else void actions.switchSession(thread.path);
  };
  return (
    <button type="button" className="md-thread-link" disabled={!actions} {...tooltipProps(thread.projectName)} onClick={open}>
      <ProjectIcon project={{ path: thread.projectPath, name: thread.projectName, workspaceId: thread.workspaceId }} />
      <span>{title || children}</span>
    </button>
  );
}
