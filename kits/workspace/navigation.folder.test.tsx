// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { PreferencesStore, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { LocalFolderSource } from "./navigation.js";
import { createWorkspaceHostClient } from "./protocol.js";
import { withWorkspaceStore } from "./store-context.js";
import { WorkspaceStore } from "./store.js";

afterEach(() => { cleanup(); setHostClient(undefined); });

function renderSource(openWorkspace = vi.fn(async () => true)) {
  const listDirectories = vi.fn(async (path?: string) => {
    if (path === "/nowhere/") throw new Error("ENOENT");
    return path === "/repos/tau" || path === "/repos/tau/"
    ? { path: "/repos/tau", parent: "/repos", directories: [], workspace: { workspaceId: "ws-tau" } }
    : { path: "/repos", parent: "/", workspace: { workspaceId: "ws-repos" }, directories: [
      { name: "satchel", path: "/repos/satchel" },
      { name: "tau", path: "/repos/tau" },
    ] };
  });
  const stub = workspaceHostStub({ listDirectories });
  setHostClient(createFakeHostClient({ invokeHostExtension: stub }));
  const store = new WorkspaceStore(new PreferencesStore(), createWorkspaceHostClient((command, input) => stub("tau.workspace", command, input)));
  const Source = withWorkspaceStore(store, LocalFolderSource);
  render(<Source actions={{ openWorkspace, notify: vi.fn() } as never} onBack={() => {}} onDone={() => {}} />);
  return { listDirectories, openWorkspace, input: () => screen.getByRole("textbox", { name: "Folder path" }) as HTMLInputElement };
}

describe("LocalFolderSource", () => {
  it("filters by the start of the name typed after the folder and navigates into a clicked one", async () => {
    const { listDirectories, input } = renderSource();
    await screen.findByText("satchel");
    expect(input().value).toBe("/repos/");
    fireEvent.change(input(), { target: { value: "/repos/ta" } });
    expect(screen.queryByText("satchel")).toBeNull();
    fireEvent.click(screen.getByText("tau"));
    await waitFor(() => expect(listDirectories).toHaveBeenLastCalledWith("/repos/tau"));
    await waitFor(() => expect(input().value).toBe("/repos/tau/"));
  });

  it("lists a folder typed as a path and adds it with Enter", async () => {
    const { listDirectories, openWorkspace, input } = renderSource();
    await screen.findByText("satchel");
    fireEvent.change(input(), { target: { value: "/repos/tau/" } });
    await waitFor(() => expect(listDirectories).toHaveBeenLastCalledWith("/repos/tau/"));
    await screen.findByText("No folders in here");
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(openWorkspace).toHaveBeenCalledWith("ws-tau"));
  });

  it("adds nothing while the typed folder does not exist", async () => {
    const { openWorkspace, input } = renderSource();
    await screen.findByText("satchel");
    fireEvent.change(input(), { target: { value: "/nowhere/" } });
    await screen.findByText("No folder at /nowhere/");
    expect(screen.queryByText("satchel")).toBeNull();
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(openWorkspace).not.toHaveBeenCalled();
  });
});
