import { getClientStorage, type DesktopExtension } from "tau";
import { COMMIT_MESSAGE_OPTIONS, registerCommitMessages } from "./commit-messages.js";
import { ReviewCommentStore } from "./comments.js";
import { COLLAPSED_OPTION, createReviewOverlay, SPLIT_OPTION, WHITESPACE_OPTION } from "./overlay.js";
import {
  COMPOSER_CONTEXT_CHIPS_SERVICE,
  REVIEW_HOST_EXTENSION_ID,
  REVIEW_OVERLAY,
  WORKSPACE_CHANGES_PANEL,
  WORKSPACE_STORE_SERVICE,
  type ComposerContextChips,
  type WorkspaceStoreApi,
} from "./protocol.js";
import { workspaceChangesReader } from "./workspace.js";
import { createRequestBadge } from "./request-badge.js";
import { createRequestSection } from "./request-section.js";
import { requestClient, RowRequests } from "./requests.js";

/**
 * Review Kit: the full review over the live worktree, the commit message the
 * host's model proposes for it, and the pull or merge request after the
 * commit — in the Changes panel, with its status on the thread's rail row.
 * Line comments on the review go to the composer as chips through Composer
 * Context's service when it is there, as text when not. The worktree belongs to Workspace Kit:
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
    const comments = new ReviewCommentStore(getClientStorage);
    let chips: ComposerContextChips | undefined;
    plugin.registerOptions([
      { id: SPLIT_OPTION, kind: "toggle", label: "Open diffs in split view", defaultValue: false },
      { id: WHITESPACE_OPTION, kind: "toggle", label: "Hide whitespace changes in diffs", defaultValue: false },
      { id: COLLAPSED_OPTION, kind: "toggle", label: "Diff files start collapsed", defaultValue: false },
      ...COMMIT_MESSAGE_OPTIONS,
    ]);
    plugin.useService<ComposerContextChips>(COMPOSER_CONTEXT_CHIPS_SERVICE, (service) => {
      chips = service;
      return () => { if (chips === service) chips = undefined; };
    });
    plugin.registerCommand({ id: "review.changes", label: "Inspect Git changes", group: "Project", run: (app) => app.openPanel(WORKSPACE_CHANGES_PANEL) });
    return plugin.useService<WorkspaceStoreApi>(WORKSPACE_STORE_SERVICE, (store) => {
      const disposers = [
        plugin.registerOverlay({ id: REVIEW_OVERLAY, profiles: ["desktop"], Component: createReviewOverlay(plugin, workspace, store, comments, () => chips) }),
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
