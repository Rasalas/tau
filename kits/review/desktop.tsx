import type { DesktopExtension } from "tau";
import { createChangesPanel } from "./changes-panel.js";
import { COMMIT_MESSAGE_OPTIONS, registerCommitMessages } from "./commit-messages.js";
import { createReviewOverlay } from "./overlay.js";
import { REVIEW_CHANGES_PANEL, REVIEW_HOST_EXTENSION_ID, REVIEW_OVERLAY, WORKSPACE_HOST_EXTENSION_ID } from "./protocol.js";
import { workspaceChangesReader } from "./workspace.js";

/**
 * Review Kit: the changes panel, the full review over the live worktree, and
 * the commit message the host's model proposes for them. The workspace state
 * itself belongs to Workspace Kit; Review reads it and asks that kit's host
 * entry for the diffs it shows.
 */
export const reviewExtension: DesktopExtension = {
  id: REVIEW_HOST_EXTENSION_ID,
  name: "Review Kit",
  activate(plugin) {
    const workspace = workspaceChangesReader(plugin.hostExtension(WORKSPACE_HOST_EXTENSION_ID));
    plugin.registerPanel({ id: REVIEW_CHANGES_PANEL, label: "Changes", glyph: "changes", order: 20, Component: createChangesPanel(plugin) });
    plugin.registerOverlay({ id: REVIEW_OVERLAY, Component: createReviewOverlay(plugin, workspace) });
    plugin.registerOptions([
      { id: "split-diff", kind: "toggle", label: "Open diffs in split view", defaultValue: false },
      ...COMMIT_MESSAGE_OPTIONS,
    ]);
    const disposeCommitMessages = registerCommitMessages(plugin);
    plugin.registerCommand({ id: "review.open", label: "Review changes", group: "Project", run: () => plugin.workspaceStore.openReview() });
    plugin.registerKeybinding({ keys: "mod+shift+d", commandId: "review.open" });
    plugin.registerCommand({ id: "review.changes", label: "Inspect Git changes", group: "Project", run: (app) => app.openPanel(REVIEW_CHANGES_PANEL) });
    return disposeCommitMessages;
  },
};

export default reviewExtension;
