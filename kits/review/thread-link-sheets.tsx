import { Suspense, lazy, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { DesktopExtensionContext, RegionProps } from "tau";
import { LinkDialogs } from "./link-dialog.js";
import { openThreadPullRequests } from "./pull-request-open.js";
import type { ThreadLinkSheetParts } from "./thread-link-sheet.js";

// The sheet is evaluated when a phone first opens it.
const ThreadLinkSheet = lazy(() => import("./thread-link-sheet.js"));

/** Drawn from a title-bar region, over the window, while a thread's pull request sheet is open. */
function createThreadLinkSheetLayer(sheets: LinkDialogs, parts: ThreadLinkSheetParts) {
  return function ThreadLinkSheetLayer({ actions }: RegionProps) {
    const target = useSyncExternalStore(sheets.subscribe, sheets.getSnapshot, sheets.getSnapshot);
    if (!target) return null;
    return createPortal(<Suspense fallback={null}><ThreadLinkSheet key={target.threadId} target={target} parts={parts} actions={actions} onClose={() => sheets.close()} /></Suspense>, document.body);
  };
}

/**
 * "Linked pull requests…" in the thread's title menu. A phone or tablet gets
 * the sheet; a desktop opens the thread's overview tab.
 */
export function registerThreadLinkSheet(plugin: Pick<DesktopExtensionContext, "registerCommand" | "registerRegion">, parts: ThreadLinkSheetParts): () => void {
  const sheets = new LinkDialogs();
  const disposers = [
    plugin.registerCommand({
      id: "review.thread-pull-requests",
      label: "Linked pull requests…",
      group: "Project",
      surfaces: ["thread-title"],
      // Opening only looks; each action in the sheet checks the device itself.
      access: "read",
      run: (actions) => {
        const thread = actions.activeThread();
        if (!thread?.sessionId) { actions.notify("Open a thread first; a pull request is linked to a thread."); return; }
        if (document.body.dataset.profile === "compact") sheets.show({ threadId: thread.sessionId, ...(thread.cwd ? { cwd: thread.cwd } : {}) });
        else openThreadPullRequests(actions, thread.sessionId, thread.cwd);
      },
    }),
    plugin.registerRegion({ id: "review.thread-link-sheet", placement: "title-bar", profiles: ["compact"], Component: createThreadLinkSheetLayer(sheets, parts) }),
  ];
  return () => { sheets.close(); for (const dispose of disposers.reverse()) dispose(); };
}
