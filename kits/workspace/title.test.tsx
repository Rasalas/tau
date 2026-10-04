// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchActions, WorkspaceInfo } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import {
  ClientStorageProvider,
  createMemoryStorage,
  HOST_CAPABILITY,
  HostClientProvider,
  PreferencesStore,
  RendererServicesProvider,
  setHostClient,
} from "../../src/renderer/test-support/kit-harness.js";
import { createWorkspaceHostClient } from "./protocol.js";
import { withWorkspaceStore } from "./store-context.js";
import { TitleActionsRow, WorkspaceEditorButton, WorkspaceTitleActions, WorkspaceStageContext } from "./title.js";
import { MAX_TITLE_COLLAPSE, titleCollapse, TITLE_COLLAPSE_STEPS } from "./title-collapse.js";
import { WorkspaceStore } from "./store.js";

const dirty = {
  files: [{ path: "src/a.ts", name: "a.ts", directory: "src", status: "modified" as const, added: 1, removed: 0 }],
  added: 1,
  removed: 0,
};

function workspace(patch: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return { root: "/project", isRepo: true, isDirty: true, branch: "main", worktrees: [], refs: [], worktreeParent: "/worktrees", ...patch };
}

function setup(info = workspace(), draftPending = false, localFiles = true, level?: number, invoke: (command: string, input: unknown) => Promise<unknown> = async () => undefined, stageContext = false) {
  const preferences = new PreferencesStore();
  const workspaceStore = new WorkspaceStore(preferences, createWorkspaceHostClient(invoke));
  const Header = level === undefined
    ? withWorkspaceStore(workspaceStore, stageContext ? WorkspaceStageContext : WorkspaceTitleActions)
    : withWorkspaceStore(workspaceStore, (props: { actions: WorkbenchActions }) => <TitleActionsRow {...props} collapse={titleCollapse(level)} />);
  const Editor = withWorkspaceStore(workspaceStore, WorkspaceEditorButton);
  // The header's row and the stage strip's editor button, side by side as the workbench draws them.
  const TitleActions = (props: { actions: WorkbenchActions }) => <><Header {...props} />{level === undefined ? null : <Editor {...props} />}</>;
  workspaceStore.update({
    cwd: "/project",
    draftPending,
    changes: dirty,
    workspace: info,
    committing: false,
    editors: [{ id: "code", name: "VS Code" }, { id: "zed", name: "Zed" }],
    terminals: [{ id: "ghostty", name: "Ghostty" }, { id: "terminal", name: "Terminal" }],
  });
  const openInEditor = vi.spyOn(workspaceStore, "openInEditor").mockResolvedValue(undefined);
  const openTerminal = vi.spyOn(workspaceStore, "openTerminal").mockResolvedValue(undefined);
  const openReview = vi.spyOn(workspaceStore, "openReview").mockImplementation(() => undefined);
  const showChangedFiles = vi.spyOn(workspaceStore, "showChangedFiles").mockImplementation(() => undefined);
  const pull = vi.spyOn(workspaceStore, "pull").mockResolvedValue(undefined);
  const runShellAction = vi.spyOn(workspaceStore, "runShellAction").mockResolvedValue(undefined);
  const client = createFakeHostClient({ hasCapability: (capability) => capability !== HOST_CAPABILITY.localFiles || localFiles });
  render(
    <HostClientProvider client={client}>
      <ClientStorageProvider storage={createMemoryStorage()}>
        <RendererServicesProvider services={{ preferences }}>
          <TitleActions actions={{ activeStageTab: () => ({ id: "panel:review.diff", kind: "panel", panelId: "review.diff", preview: false }) } as WorkbenchActions} />
        </RendererServicesProvider>
      </ClientStorageProvider>
    </HostClientProvider>,
  );
  return { workspaceStore, openInEditor, openTerminal, openReview, showChangedFiles, pull, runShellAction };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Workspace Kit title actions", () => {
  it("opens the preferred editor and opens a selected editor from the split menu", () => {
    const { openInEditor } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(openInEditor).toHaveBeenCalledWith(undefined, "code");
    fireEvent.click(screen.getByRole("button", { name: "Choose editor" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Zed" }));
    expect(openInEditor).toHaveBeenCalledWith(undefined, "zed");
  });

  it("names the real editor and reports working-tree additions and deletions", () => {
    setup();
    expect(screen.getByRole("button", { name: "Open" }).textContent).toBe("Open in VS Code");
    expect(screen.getByLabelText("Working tree: 1 additions, 0 deletions").textContent).toBe("+1−0");
  });

  it("identifies a distinct worktree without adding a project heading to the main checkout", () => {
    setup(workspace({ worktrees: [{ path: "/project", name: "project-feature", isCurrent: true, isMain: false, branch: "feature" }] }));
    const card = screen.getByRole("region", { name: "Project workspace" });
    expect(within(card).getByText("project-feature")).toBeTruthy();
    expect(within(card).getByText("Worktree")).toBeTruthy();
    cleanup();
    setup();
    expect(screen.getByRole("region", { name: "Project workspace" }).querySelector(".workspace-card-identity")).toBeNull();
  });

  it("mounts and removes feature-owned workspace sections with their contribution", () => {
    const { workspaceStore } = setup();
    let dispose: () => void;
    act(() => { dispose = workspaceStore.registerWorkspaceSummarySection(() => <button>Linked request</button>); });
    expect(within(screen.getByRole("region", { name: "Project workspace" })).getByRole("button", { name: "Linked request" })).toBeTruthy();
    act(() => dispose());
    expect(screen.queryByRole("button", { name: "Linked request" })).toBeNull();
  });

  it("keeps editor actions available for a draft whose project is known", () => {
    const { openInEditor } = setup(workspace(), true);
    const open = screen.getByRole("button", { name: "Open" });
    expect(open.hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Choose editor" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(open);
    expect(openInEditor).toHaveBeenCalledWith(undefined, "code");
  });

  it("offers no editor action when the host's files are not on this machine", () => {
    setup(workspace(), false, false);
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Choose editor" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open in terminal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Choose terminal" })).toBeNull();
    // The Git actions of the same bar stay: they do not touch this machine.
    expect(screen.getByRole("button", { name: "Commit" })).toBeTruthy();
  });

  it("draws no external terminal button; the terminal opens in the app", () => {
    setup();
    expect(screen.queryByRole("button", { name: "Open in terminal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Choose terminal" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Choose editor" }));
    expect(within(screen.getByRole("menu", { name: "Open in" })).queryByRole("menuitem", { name: "Ghostty" })).toBeNull();
  });

  it("folds labels first, then the project actions into More, and the Git action's label last", () => {
    expect(TITLE_COLLAPSE_STEPS[0]).toEqual({ actions: "label", git: "label", changes: "label" });
    // Each step takes one more thing away and gives nothing back.
    const rank = { label: 0, icon: 1, short: 1, overflow: 2 } as const;
    for (let level = 1; level < MAX_TITLE_COLLAPSE; level += 1) {
      const before = titleCollapse(level - 1);
      const after = titleCollapse(level);
      const moved = (["actions", "git", "changes"] as const).filter((item) => rank[after[item]] !== rank[before[item]]);
      expect(moved).toHaveLength(1);
      expect(rank[after[moved[0]!]]).toBeGreaterThan(rank[before[moved[0]!]]);
    }
    // The Git action keeps its words until only the changes' count can still give way; it never leaves the header.
    expect(TITLE_COLLAPSE_STEPS.findIndex((step) => step.git === "icon")).toBe(MAX_TITLE_COLLAPSE - 2);
    expect(TITLE_COLLAPSE_STEPS.findIndex((step) => step.changes === "short")).toBe(MAX_TITLE_COLLAPSE - 1);
    // Last, its menu joins More, so the row is design 1a's "N files", Commit and "…".
    expect(titleCollapse(MAX_TITLE_COLLAPSE)).toEqual({ ...titleCollapse(MAX_TITLE_COLLAPSE - 1), gitMenu: "overflow" });
    expect(titleCollapse(99)).toEqual(titleCollapse(MAX_TITLE_COLLAPSE));
  });

  it("keeps every action reachable at the tightest fold, through More", () => {
    const { openReview } = setup(workspace(), false, true, MAX_TITLE_COLLAPSE);
    expect(screen.queryByRole("button", { name: "Add action" })).toBeNull();
    // The Git action is an icon now; its name stays its accessible name.
    const commit = screen.getByRole("button", { name: "Commit" });
    expect(commit.textContent).toBe("");
    fireEvent.click(commit);
    expect(openReview).toHaveBeenCalledWith(undefined, false);

    // The Git menu has no chevron of its own any more; its entries are in More.
    expect(screen.queryByRole("button", { name: "Choose Git action" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(within(screen.getByRole("menu", { name: "More actions" })).getByRole("menuitem", { name: /^Review changes/u })).toBeTruthy();
    // Adding an action from More opens the same form.
    fireEvent.click(within(screen.getByRole("menu", { name: "More actions" })).getByRole("menuitem", { name: /Add action/u }));
    expect(screen.getByPlaceholderText("!! npm test")).toBeTruthy();
  });

  it("groups project context and actions in the workspace card", () => {
    setup();
    const card = screen.getByRole("region", { name: "Project workspace" });
    expect(within(card).getByRole("button", { name: "Add project script" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Commit" }).textContent).toBe("Commit");
    expect(within(card).getByRole("button", { name: "Open" })).toBeTruthy();
  });

  it("drops the project actions' labels before anything leaves the header", () => {
    setup(workspace(), false, true, 1);
    expect(screen.getByRole("button", { name: "Add action" }).textContent).toBe("");
    expect(screen.getByRole("button", { name: "Commit" }).textContent).toBe("Commit");
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });

  it("names the changed files and shows them on the stage, as the design's \"N files changed ›\"", () => {
    const { showChangedFiles } = setup();
    const link = screen.getByRole("button", { name: /1 file changed/u });
    fireEvent.click(link);
    expect(showChangedFiles).toHaveBeenCalledOnce();
  });

  it("keeps the workspace count and line totals in the working-tree scope", async () => {
    const invoke = vi.fn(async (command: string) => command === "thread-changes" ? { files: 2, scope: "thread", uncommitted: 5 } : undefined);
    setHostClient(createFakeHostClient());
    try {
      setup(workspace(), false, true, undefined, invoke);
      expect((await screen.findByRole("button", { name: /1 file changed/u })).querySelector(".workspace-card-label")?.textContent).toBe("Changes");
      expect(invoke).toHaveBeenCalledWith("thread-changes", { sessionId: undefined, workspace: undefined });
    } finally {
      setHostClient(undefined);
    }
  });

  it("shortens the changes to \"N files\" at the tightest fold, the Git action a square icon", () => {
    setup(workspace(), false, true, MAX_TITLE_COLLAPSE);
    expect(screen.getByRole("button", { name: "1 file" }).textContent).toBe("1 file");
    expect(screen.getByRole("button", { name: "Commit" }).className).toContain("icon-only");
  });

  it("chooses commit versus commit and push from upstream state", () => {
    const withoutUpstream = setup();
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));
    expect(withoutUpstream.openReview).toHaveBeenCalledWith(undefined, false);
    cleanup();
    vi.restoreAllMocks();

    const withUpstream = setup(workspace({ upstream: "origin/main" }));
    fireEvent.click(screen.getByRole("button", { name: "Commit & push" }));
    expect(withUpstream.openReview).toHaveBeenCalledWith(undefined, true);
  });

  it("pulls a branch that is behind its upstream", () => {
    const { pull } = setup(workspace({ upstream: "origin/main", behind: 2 }));
    const button = screen.getByRole("button", { name: "Pull" });
    expect(button.hasAttribute("disabled")).toBe(false);
    fireEvent.click(button);
    expect(pull).toHaveBeenCalledOnce();
  });

  it("adds and runs a hidden Pi shell action", () => {
    const { runShellAction } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add project script" }));
    fireEvent.change(screen.getByPlaceholderText("Test"), { target: { value: "Tests" } });
    fireEvent.change(screen.getByPlaceholderText("!! npm test"), { target: { value: "!! npm test" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Tests" }));
    expect(runShellAction).toHaveBeenCalledWith("npm test", false, "Tests");
  });
});

it("keeps project actions reachable through a quiet stage icon without duplicating changed files", async () => {
  const { openInEditor, openReview } = setup(workspace(), false, true, undefined, async () => undefined, true);
  const trigger = screen.getByRole("button", { name: "Project actions" });
  expect(trigger.textContent).toBe("");
  expect(screen.queryByRole("region", { name: "Project workspace" })).toBeNull();
  expect(screen.queryByRole("dialog", { name: "Project actions" })).toBeNull();
  fireEvent.click(trigger);
  const menu = await screen.findByRole("dialog", { name: "Project actions" });
  fireEvent.click(await within(menu).findByRole("button", { name: "Open" }));
  expect(openInEditor).toHaveBeenCalledWith(undefined, "code");
  expect(menu.querySelector(".workspace-changes-link")).toBeNull();
  fireEvent.click(within(menu).getByRole("button", { name: "Choose Git action" }));
  const commit = await screen.findByRole("menuitem", { name: "Commit" });
  fireEvent.pointerDown(commit);
  fireEvent.click(commit);
  expect(openReview).toHaveBeenCalledWith(undefined, false);
});
