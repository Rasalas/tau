import { GitCompare } from "lucide-react";
import { getClientStorage, type DesktopExtension } from "tau";
import { COMMIT_MESSAGE_OPTIONS, registerCommitMessages } from "./commit-messages.js";
import { ReviewCommentStore } from "./comments.js";
import { createReviewOverlay } from "./overlay.js";
import { trackDiffSettings } from "./diff-settings.js";
import { createReviewSettingsPage } from "./settings-page.js";
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
import { LinkDialogs } from "./link-dialog.js";
import { PendingReviewStore } from "./pending-review.js";
import { createProactivePanels } from "./proactive-panels.js";
import { pullRequestClient } from "./pull-request-client.js";
import { registerPullRequestTab } from "./pull-request-tab.js";
import { requestClient, RowRequests } from "./requests.js";
import { ThreadLinkRows } from "./thread-links-store.js";

/**
 * Review Kit: the full review over the live worktree, the commit message the
 * host's model proposes for it, and the pull or merge request after the
 * commit — in the Changes panel, with its status on the thread's rail row —
 * and the request itself as a stage tab: summary, timeline and code.
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
    const client = pullRequestClient(plugin.host);
    const links = new ThreadLinkRows(client);
    const shared = { links, pending: new PendingReviewStore(getClientStorage), preferences: plugin.preferences, dialogs: new LinkDialogs() };
    let chips: ComposerContextChips | undefined;
    let workspaceStore: WorkspaceStoreApi | undefined;
    // The rest of the kit's settings are its Review page; the model picker stays here.
    plugin.registerOptions(COMMIT_MESSAGE_OPTIONS.filter((entry) => entry.kind === "model"));
    plugin.registerSettingsPage({
      id: "review.settings",
      label: "Review",
      Icon: GitCompare,
      order: 36,
      scope: "both",
      keywords: ["commit message", "pull request", "merge request", "template", "instructions", "diff", "colours", "colors", "blue", "orange", "wrap", "split", "whitespace",
        "delete branch", "merge", "proactive panels",
        "git hosts", "github", "gitlab", "forgejo", "gitea", "codeberg", "bitbucket", "azure devops", "self-hosted", "tea", "az"],
      profiles: ["desktop", "web"],
      Component: createReviewSettingsPage(plugin.host),
    });
    const untrackDiffSettings = trackDiffSettings(plugin.preferences);
    plugin.useService<ComposerContextChips>(COMPOSER_CONTEXT_CHIPS_SERVICE, (service) => {
      chips = service;
      return () => { if (chips === service) chips = undefined; };
    });
    plugin.registerCommand({ id: "review.changes", label: "Inspect Git changes", group: "Project", run: (app) => app.openPanel(WORKSPACE_CHANGES_PANEL) });
    // The view reads a request by its URL, so it does not wait for Workspace Kit's store.
    const releaseTabs = registerPullRequestTab(plugin, requests, rows, () => chips, client, shared);
    const releaseProactive = plugin.registerRegion({ id: "review.proactive-panels", placement: "title-bar", profiles: ["desktop"], Component: createProactivePanels(plugin, links, () => workspaceStore) });
    const releaseStore = plugin.useService<WorkspaceStoreApi>(WORKSPACE_STORE_SERVICE, (store) => {
      workspaceStore = store;
      const disposers = [
        plugin.registerOverlay({ id: REVIEW_OVERLAY, profiles: ["desktop"], Component: createReviewOverlay(plugin, workspace, store, comments, () => chips) }),
        plugin.registerCommand({ id: "review.open", label: "Review changes", group: "Project", run: () => store.openReview() }),
        plugin.registerSlashCommand({ name: "review", description: "Open the full Git review overlay", run: () => { store.openReview(); return undefined; } }),
        plugin.registerKeybinding({ keys: "mod+shift+d", commandId: "review.open" }),
        // T3 Code's diff toggle; in a terminal `mod+d` splits it.
        plugin.registerCommand({ id: "review.toggle", label: "Toggle the review", group: "Project", run: () => { if (store.getSnapshot().review) store.closeReview(); else store.openReview(); } }),
        plugin.registerKeybinding({ keys: "mod+d", commandId: "review.toggle", when: "!terminalFocus" }),
        registerCommitMessages(plugin, store),
        store.registerChangesSection(createRequestSection(plugin, store, requests, rows, { rows: links, client, dialogs: shared.dialogs })),
        store.registerThreadRowAccessory(createRequestBadge(rows, links)),
      ];
      return () => { if (workspaceStore === store) workspaceStore = undefined; for (const dispose of disposers.reverse()) dispose(); };
    });
    return () => { releaseStore(); releaseProactive(); releaseTabs(); links.dispose(); shared.dialogs.close(); untrackDiffSettings(); };
  },
};

export default reviewExtension;
