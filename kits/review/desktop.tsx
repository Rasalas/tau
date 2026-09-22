import type { DesktopExtension } from "tau";
import { COMMIT_MESSAGE_OPTIONS, registerCommitMessages } from "./commit-messages.js";
import { createReviewOverlay } from "./overlay.js";
import { REVIEW_HOST_EXTENSION_ID, REVIEW_OVERLAY, WORKSPACE_CHANGES_PANEL, WORKSPACE_STORE_SERVICE, type WorkspaceStoreApi } from "./protocol.js";
import { workspaceChangesReader } from "./workspace.js";
import { createRequestBadge } from "./request-badge.js";
import { createRequestSection } from "./request-section.js";
import { requestClient, RowRequests } from "./requests.js";

/**
 * Review Kit: the full review over the live worktree, the commit message the
 * host's model proposes for it, and the pull or merge request after the
 * commit — in the Changes panel, with its status on the thread's rail row. The worktree belongs to Workspace Kit:
 * Review reads its changes through that kit's host entry and its state
 * through the store that kit publishes, so the review comes and goes with it.
 */
export const reviewExtension: DesktopExtension = {
  id: REVIEW_HOST_EXTENSION_ID,
  name: "Review Kit",
  activate(plugin) {
    const workspace = workspaceChangesReader(plugin.host);
    const requests = requestClient(plugin.host);
    const rows = new RowRequests((path) => requests.request(path));
    plugin.registerOptions([
      { id: "split-diff", kind: "toggle", label: "Open diffs in split view", defaultValue: false },
      ...COMMIT_MESSAGE_OPTIONS,
    ]);
    plugin.registerCommand({ id: "review.changes", label: "Inspect Git changes", group: "Project", run: (app) => app.openPanel(WORKSPACE_CHANGES_PANEL) });
    return plugin.useService<WorkspaceStoreApi>(WORKSPACE_STORE_SERVICE, (store) => {
      const disposers = [
        plugin.registerOverlay({ id: REVIEW_OVERLAY, profiles: ["desktop"], Component: createReviewOverlay(plugin, workspace, store) }),
        plugin.registerCommand({ id: "review.open", label: "Review changes", group: "Project", run: () => store.openReview() }),
        plugin.registerSlashCommand({ name: "review", description: "Open the full Git review overlay", run: () => { store.openReview(); return undefined; } }),
        plugin.registerKeybinding({ keys: "mod+shift+d", commandId: "review.open" }),
        registerCommitMessages(plugin, store),
        store.registerChangesSection(createRequestSection(plugin, store, requests, rows)),
        store.registerThreadRowAccessory(createRequestBadge(rows)),
      ];
      return () => { for (const dispose of disposers.reverse()) dispose(); };
    });
  },
};

export default reviewExtension;
