import { Suspense, lazy } from "react";
import { GitCompare } from "lucide-react";
import { THREAD_PULL_REQUESTS_SERVICE, getClientStorage, type DesktopExtension, type PanelProps, type RegionProps } from "tau";
import { threadPullRequestsService } from "./pull-requests-service.js";
import { COMMIT_MESSAGE_OPTIONS, registerCommitMessages } from "./commit-messages.js";
import { ReviewCommentStore } from "./comments.js";
import { createReviewOverlay } from "./overlay.js";
import { trackDiffSettings } from "./diff-settings.js";
import { createReviewSettingsPage, REVIEW_SETTINGS_ROWS } from "./settings-page.js";
import {
  COMPOSER_CONTEXT_CHIPS_SERVICE,
  REVIEW_COMPACT_PANEL,
  REVIEW_HOST_EXTENSION_ID,
  REVIEW_OVERLAY,
  WORKSPACE_HOST_EXTENSION_ID,
  WORKSPACE_CHANGES_PANEL,
  WORKSPACE_STORE_SERVICE,
  type ComposerContextChips,
  type WorkspaceStoreApi,
} from "./protocol.js";
import { workspaceChangesReader } from "./workspace.js";
import { createRequestBadge, createRequestCardSection } from "./request-badge.js";
import { createRequestSection } from "./request-section.js";
import { LinkDialogs } from "./link-dialog.js";
import { PendingReviewStore } from "./pending-review.js";
import { createProactivePanels } from "./proactive-panels.js";
import { pullRequestClient } from "./pull-request-client.js";
import { registerPullRequestTab } from "./pull-request-tab.js";
import { LocalReviewsStore } from "./local-reviews-store.js";
import { requestClient, RowRequests } from "./requests.js";
import { ThreadLinkRows } from "./thread-links-store.js";
import type { StripParts } from "./pull-request-strip.js";
import { EVIDENCE_SERVICE, localRequestClient, type EvidenceService } from "./local-request-client.js";
import { PROJECT_SCRIPTS_EXTENSION_ID } from "./local-request-checks.js";
import { openLocalPullRequest, registerLocalRequestTab } from "./local-request-tab.js";
import { evidenceKey, LocalDrafts, REVIEW_ATTACH_SERVICE, type ReviewAttachService } from "./local-request.js";
import { CompactReviewStore } from "./compact-store.js";
import { createCompactTurnPill } from "./turn-pill.js";
import type { CompactReviewDeps } from "./compact-review.js";

// Evaluated on the first thread drawn, not when the kit activates.
const PullRequestStrip = lazy(() => import("./pull-request-strip.js"));

/** The phone's review, evaluated when its sheet first opens. */
function createCompactReviewPanel(deps: CompactReviewDeps) {
  const Panel = lazy(() => import("./compact-review.js").then((module) => ({ default: module.createCompactReview(deps) })));
  return function CompactReviewPanel(props: PanelProps) {
    return <Suspense fallback={null}><Panel {...props} /></Suspense>;
  };
}

function createPullRequestStrip(parts: StripParts) {
  return function PullRequestStripRegion(props: RegionProps) {
    return <Suspense fallback={null}><PullRequestStrip {...props} parts={parts} /></Suspense>;
  };
}

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
    // A thread's requests, for any package: a public contract, unlike the kit's protocol.
    plugin.provideService(THREAD_PULL_REQUESTS_SERVICE, threadPullRequestsService(links));
    const shared = { links, pending: new PendingReviewStore(getClientStorage), preferences: plugin.preferences, dialogs: new LinkDialogs() };
    let chips: ComposerContextChips | undefined;
    let workspaceStore: WorkspaceStoreApi | undefined;
    // The rest of the kit's settings are its Review page; the model picker stays here.
    plugin.registerOptions(COMMIT_MESSAGE_OPTIONS.filter((entry) => entry.kind === "model"));
    plugin.registerSettingsPage({
      id: "review.settings",
      label: "Review",
      description: "How a thread's changes are reviewed and handed in: commit messages, pull requests, merging and the look of diffs.",
      group: "projects",
      Icon: GitCompare,
      order: 36,
      scope: "both",
      keywords: ["commit message", "pull request", "merge request", "template", "instructions", "diff", "colours", "colors", "blue", "orange", "wrap", "split", "whitespace",
        "delete branch", "merge", "proactive panels", "composer", "strip",
        "git hosts", "github", "gitlab", "forgejo", "gitea", "codeberg", "bitbucket", "azure devops", "self-hosted", "tea", "az"],
      rows: REVIEW_SETTINGS_ROWS,
      profiles: ["desktop", "web"],
      Component: createReviewSettingsPage(plugin.host),
    });
    const untrackDiffSettings = trackDiffSettings(plugin.preferences);
    plugin.useService<ComposerContextChips>(COMPOSER_CONTEXT_CHIPS_SERVICE, (service) => {
      chips = service;
      return () => { if (chips === service) chips = undefined; };
    });
    plugin.registerCommand({ id: "review.changes", label: "Inspect Git changes", group: "Project", access: "read", run: (app) => app.openPanel(WORKSPACE_CHANGES_PANEL) });
    // A phone or a tablet reads diffs in a sheet from the title bar; the desktop's overlay and Changes panel are not drawn there.
    const compactStore = new CompactReviewStore();
    const workspaceHost = plugin.hostExtension(WORKSPACE_HOST_EXTENSION_ID);
    plugin.registerPanel({
      id: REVIEW_COMPACT_PANEL,
      label: "Review",
      Icon: GitCompare,
      order: 20,
      width: "wide",
      maximizable: true,
      profiles: ["compact"],
      Component: createCompactReviewPanel({
        reader: workspace,
        workspace: workspaceHost,
        requests,
        comments: new ReviewCommentStore(getClientStorage),
        store: compactStore,
      }),
    });
    // Over the composer, the latest turn's pill opens that sheet on the turn's files.
    plugin.registerRegion({ id: "review.turn-pill", placement: "composer-controls", order: 70, profiles: ["compact"], Component: createCompactTurnPill({ workspace: workspaceHost, store: compactStore }) });
    // The view reads a request by its URL, so it does not wait for Workspace Kit's store.
    // Reviews: finished threads' worktree branches; Project Scripts' runs are their checks.
    const reviews = new LocalReviewsStore(plugin.host, plugin.hostExtension(PROJECT_SCRIPTS_EXTENSION_ID));
    const releaseTabs = registerPullRequestTab(plugin, requests, rows, () => chips, client, shared, { store: reviews, host: plugin.host });
    // Evidence Kit shrinks the pictures and says when a thread's changed; without it the view reads them whole.
    let evidence: EvidenceService | undefined;
    const evidenceListeners = new Set<() => void>();
    const releaseEvidence = plugin.useService<EvidenceService>(EVIDENCE_SERVICE, (service) => {
      evidence = service;
      const off = service.subscribe(() => { for (const listener of [...evidenceListeners]) listener(); });
      return () => { off(); if (evidence === service) evidence = undefined; };
    });
    const drafts = new LocalDrafts(getClientStorage);
    const attachService: ReviewAttachService = {
      attach: (media, actions) => {
        const snapshot = workspaceStore?.getSnapshot();
        if (!snapshot?.cwd) return false;
        drafts.attach(snapshot.cwd, snapshot.workspace?.branch, media.map(evidenceKey));
        openLocalPullRequest(actions);
        return true;
      },
    };
    const releaseAttach = plugin.provideService(REVIEW_ATTACH_SERVICE, attachService);
    const releaseLocal = registerLocalRequestTab(plugin, {
      client: localRequestClient(plugin.host, () => evidence),
      requests,
      rows,
      changes: workspace,
      store: () => workspaceStore,
      scripts: plugin.hostExtension(PROJECT_SCRIPTS_EXTENSION_ID),
      preferences: plugin.preferences,
      drafts,
      onEvidence: (listener) => { evidenceListeners.add(listener); return () => { evidenceListeners.delete(listener); }; },
    });
    const releaseProactive = plugin.registerRegion({ id: "review.proactive-panels", placement: "title-bar", profiles: ["desktop"], Component: createProactivePanels(plugin, links, () => workspaceStore) });
    // Below the runtime banners, Pi's widgets and quick actions; above Thread Rail's settled note (90), which sits on the composer.
    const releaseStrip = plugin.registerRegion({ id: "review.pull-request-strip", placement: "composer-above", order: 80, profiles: ["desktop", "web"], Component: createPullRequestStrip({ rows, links, preferences: plugin.preferences }) });
    const releaseStore = plugin.useService<WorkspaceStoreApi>(WORKSPACE_STORE_SERVICE, (store) => {
      workspaceStore = store;
      const disposers = [
        plugin.registerOverlay({ id: REVIEW_OVERLAY, profiles: ["desktop"], Component: createReviewOverlay(plugin, workspace, store, comments, () => chips) }),
        // The Changes rail entry opens this review, which carries the panel's commit, staging and sections.
        store.registerReviewView?.() ?? (() => undefined),
        plugin.registerCommand({ id: "review.open", label: "Review changes", group: "Project", access: "read", run: () => store.openReview() }),
        plugin.registerSlashCommand({ name: "review", description: "Open the full Git review overlay", run: () => { store.openReview(); return undefined; } }),
        plugin.registerKeybinding({ keys: "mod+shift+d", commandId: "review.open" }),
        // The diff toggle; in a terminal `mod+d` splits it.
        plugin.registerCommand({ id: "review.toggle", label: "Toggle the review", group: "Project", access: "read", run: () => { if (store.getSnapshot().review) store.closeReview(); else store.openReview(); } }),
        plugin.registerKeybinding({ keys: "mod+d", commandId: "review.toggle", when: "!terminalFocus" }),
        registerCommitMessages(plugin, store),
        store.registerChangesSection(createRequestSection(plugin, store, requests, rows, { rows: links, client, dialogs: shared.dialogs })),
        store.registerThreadRowAccessory(createRequestBadge(rows, links)),
        store.registerThreadCardSection?.({ place: "section", order: 10, Component: createRequestCardSection(rows, links) }) ?? (() => undefined),
      ];
      return () => { if (workspaceStore === store) workspaceStore = undefined; for (const dispose of disposers.reverse()) dispose(); };
    });
    return () => { releaseStore(); releaseStrip(); releaseProactive(); releaseAttach(); releaseLocal(); releaseEvidence(); releaseTabs(); reviews.dispose(); links.dispose(); shared.dialogs.close(); untrackDiffSettings(); };
  },
};

export default reviewExtension;
