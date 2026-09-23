import { lazy, Suspense } from "react";
import { GitPullRequestDraft } from "lucide-react";
import { Spinner, type DesktopExtensionContext, type WorkbenchActions } from "tau";
import { LOCAL_PULL_REQUEST_TAB } from "./local-request.js";
import type { LocalRequestParts } from "./local-request-view.js";

// Opened on demand; its code stays out of the kit's first evaluation.
const LocalRequestView = lazy(() => import("./local-request-view.js"));

/** One tab for the checkout on screen; it follows the host's workspace. */
export function openLocalPullRequest(actions: Pick<WorkbenchActions, "openStageTab">): string {
  return actions.openStageTab(LOCAL_PULL_REQUEST_TAB, {}, { key: LOCAL_PULL_REQUEST_TAB });
}

/** The local pull request as a stage-tab kind, and the palette command that opens it. */
export function registerLocalRequestTab(plugin: DesktopExtensionContext, parts: LocalRequestParts): () => void {
  const disposers = [
    plugin.registerStageTab({
      kind: LOCAL_PULL_REQUEST_TAB,
      profiles: ["desktop"],
      title: () => "Local PR",
      Icon: GitPullRequestDraft,
      render: (_params, handle, actions) => (
        <Suspense fallback={<div className="stage-empty" role="status"><Spinner size="sm" label="Loading the local pull request" /></div>}>
          <LocalRequestView handle={handle} actions={actions} parts={parts} />
        </Suspense>
      ),
      restore: () => true,
    }),
    plugin.registerCommand({
      id: "review.local-pull-request.open",
      label: "Local pull request",
      group: "Project",
      run: (actions) => { openLocalPullRequest(actions); },
    }),
  ];
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
