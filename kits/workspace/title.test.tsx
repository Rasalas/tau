// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
import { WorkspaceTitleActions } from "./title.js";
import { WorkspaceStore } from "./store.js";

const dirty = {
  files: [{ path: "src/a.ts", name: "a.ts", directory: "src", status: "modified" as const, added: 1, removed: 0 }],
  added: 1,
  removed: 0,
};

function workspace(patch: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return { root: "/project", isRepo: true, isDirty: true, branch: "main", worktrees: [], refs: [], worktreeParent: "/worktrees", ...patch };
}

function setup(info = workspace(), draftPending = false, localFiles = true) {
  const preferences = new PreferencesStore();
  const workspaceStore = new WorkspaceStore(preferences, createWorkspaceHostClient(async () => undefined));
  const TitleActions = withWorkspaceStore(workspaceStore, WorkspaceTitleActions);
  workspaceStore.update({ cwd: "/project", draftPending, changes: dirty, workspace: info, committing: false, editors: [{ id: "code", name: "VS Code" }, { id: "zed", name: "Zed" }] });
  const openInEditor = vi.spyOn(workspaceStore, "openInEditor").mockResolvedValue(undefined);
  const openReview = vi.spyOn(workspaceStore, "openReview").mockImplementation(() => undefined);
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
  return { openInEditor, openReview, pull, runShellAction };
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

  it("disables editor actions while a draft is pending", () => {
    setup(workspace(), true);
    expect(screen.getByRole("button", { name: "Open" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Choose editor" }).hasAttribute("disabled")).toBe(true);
  });

  it("offers no editor action when the host's files are not on this machine", () => {
    setup(workspace(), false, false);
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Choose editor" })).toBeNull();
    // The Git actions of the same bar stay: they do not touch this machine.
    expect(screen.getByRole("button", { name: "Commit" })).toBeTruthy();
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
