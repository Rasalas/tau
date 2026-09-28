// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
} from "../../src/renderer/test-support/kit-harness.js";
import { createWorkspaceHostClient } from "./protocol.js";
import { withWorkspaceStore } from "./store-context.js";
import { TitleActionsRow, WorkspaceEditorButton, WorkspaceTitleActions } from "./title.js";
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

function setup(info = workspace(), draftPending = false, localFiles = true, level?: number) {
  const preferences = new PreferencesStore();
  const workspaceStore = new WorkspaceStore(preferences, createWorkspaceHostClient(async () => undefined));
  const Header = level === undefined
    ? withWorkspaceStore(workspaceStore, WorkspaceTitleActions)
    : withWorkspaceStore(workspaceStore, (props: { actions: WorkbenchActions }) => <TitleActionsRow {...props} collapse={titleCollapse(level)} />);
  const Editor = withWorkspaceStore(workspaceStore, WorkspaceEditorButton);
  // The header's row and the stage strip's editor button, side by side as the workbench draws them.
  const TitleActions = (props: { actions: WorkbenchActions }) => <><Header {...props} /><Editor {...props} /></>;
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
  const openChangesView = vi.spyOn(workspaceStore, "openChangesView").mockReturnValue(true);
  const pull = vi.spyOn(workspaceStore, "pull").mockResolvedValue(undefined);
  const runShellAction = vi.spyOn(workspaceStore, "runShellAction").mockResolvedValue(undefined);
  const client = createFakeHostClient({ hasCapability: (capability) => capability !== HOST_CAPABILITY.localFiles || localFiles });
  render(
    <HostClientProvider client={client}>
      <ClientStorageProvider storage={createMemoryStorage()}>
        <RendererServicesProvider services={{ preferences }}>
          <TitleActions actions={{} as WorkbenchActions} />
        </RendererServicesProvider>
      </ClientStorageProvider>
    </HostClientProvider>,
  );
  return { openInEditor, openTerminal, openReview, openChangesView, pull, runShellAction };
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
    expect(TITLE_COLLAPSE_STEPS[0]).toEqual({ actions: "label", git: "label" });
    // Each step takes one more thing away and gives nothing back.
    const rank = { label: 0, icon: 1, overflow: 2 } as const;
    for (let level = 1; level <= MAX_TITLE_COLLAPSE; level += 1) {
      const before = titleCollapse(level - 1);
      const after = titleCollapse(level);
      const moved = (["actions", "git"] as const).filter((item) => rank[after[item]] !== rank[before[item]]);
      expect(moved).toHaveLength(1);
      expect(rank[after[moved[0]!]]).toBeGreaterThan(rank[before[moved[0]!]]);
    }
    // The Git action keeps its words longest and never leaves the header.
    expect(TITLE_COLLAPSE_STEPS.findIndex((step) => step.git === "icon")).toBe(MAX_TITLE_COLLAPSE);
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

    // Adding an action from More opens the same form.
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "More actions" })).getByRole("menuitem", { name: /Add action/u }));
    expect(screen.getByPlaceholderText("!! npm test")).toBeTruthy();
  });

  it("folds one step at a time until its row fits the room the header gives it", () => {
    // jsdom lays nothing out: every control is 120 px wide, More 30, and the row gets 200 (jsdom has no gap).
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockReturnValue(document.body);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("workspace-changes-link")) return 0;
      return this.querySelector(".title-more") ? 30 : 120;
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("workspace-title-actions") ? 200 : 0;
    });
    setup();
    // Actions and Commit (240 px) do not fit; More and Commit (150 px) do, and the Git action keeps its word.
    expect(screen.queryByRole("button", { name: "Add action" })).toBeNull();
    expect(screen.getByRole("button", { name: "More actions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Commit" }).textContent).toBe("Commit");
  });

  it("drops the project actions' labels before anything leaves the header", () => {
    setup(workspace(), false, true, 1);
    expect(screen.getByRole("button", { name: "Add action" }).textContent).toBe("");
    expect(screen.getByRole("button", { name: "Commit" }).textContent).toBe("Commit");
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });

  it("names the changed files and opens the review from them, as the design's \"N files changed ›\"", () => {
    const { openChangesView } = setup();
    const link = screen.getByRole("button", { name: /1 file changed/u });
    fireEvent.click(link);
    expect(openChangesView).toHaveBeenCalledOnce();
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
    fireEvent.click(screen.getByRole("button", { name: "Add action" }));
    fireEvent.change(screen.getByPlaceholderText("Test"), { target: { value: "Tests" } });
    fireEvent.change(screen.getByPlaceholderText("!! npm test"), { target: { value: "!! npm test" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Tests" }));
    expect(runShellAction).toHaveBeenCalledWith("npm test", false, "Tests");
  });
});
