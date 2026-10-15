// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { PreferencesStore, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { LocalFolderSource } from "./folder-picker.js";
import { createWorkspaceHostClient, type UiDirectoryListing, type UiFolderIndex } from "./protocol.js";
import { withWorkspaceStore } from "./store-context.js";
import { WorkspaceStore } from "./store.js";

afterEach(() => { cleanup(); setHostClient(undefined); });

const LISTINGS: Record<string, UiDirectoryListing> = {
  "/repos": { path: "/repos", parent: "/", workspace: { workspaceId: "ws-repos", displayPath: "/repos" }, directories: [
    { name: "_self", path: "/repos/_self" },
    { name: "notes", path: "/repos/notes", repository: "git" },
  ] },
  "/repos/_self": { path: "/repos/_self", parent: "/repos", workspace: { workspaceId: "ws-self", displayPath: "/repos/_self" }, directories: [
    { name: "intranet", path: "/repos/_self/intranet", repository: "gitlab" },
    { name: "tau", path: "/repos/_self/tau", repository: "github" },
  ] },
  "/repos/_self/tau": { path: "/repos/_self/tau", parent: "/repos/_self", workspace: { workspaceId: "ws-tau", displayPath: "/repos/_self/tau" }, directories: [] },
  "/Users/me": { path: "/Users/me", parent: "/Users", workspace: { workspaceId: "ws-home", displayPath: "/Users/me" }, directories: [{ name: "Documents", path: "/Users/me/Documents" }] },
};
const ALIASES: Record<string, string> = { "/repos/": "/repos", "~/": "/Users/me", "~": "/Users/me" };

function renderSource() {
  const listDirectories = vi.fn(async (path?: string) => {
    const listing = LISTINGS[ALIASES[path ?? ""] ?? path ?? "/Users/me"];
    if (!listing) throw new Error("ENOENT");
    return listing;
  });
  const findFolders = vi.fn(async (path?: string): Promise<UiFolderIndex> => ({ root: path ?? "/Users/me", truncated: false, folders: path === "/repos" ? [
    { path: "_self" },
    { path: "_self/intranet", repository: "gitlab" },
    { path: "_self/tau", repository: "github" },
    { path: "notes", repository: "git" },
  ] : [] }));
  const openWorkspace = vi.fn(async () => true);
  const stub = workspaceHostStub({ listDirectories, findFolders });
  setHostClient(createFakeHostClient({ invokeHostExtension: stub }));
  const store = new WorkspaceStore(new PreferencesStore(), createWorkspaceHostClient((command, input) => stub("tau.workspace", command, input)));
  store.setProjectBaseDirectory("/repos");
  const Source = withWorkspaceStore(store, LocalFolderSource);
  render(<Source actions={{ openWorkspace, notify: vi.fn() } as never} onBack={() => {}} onDone={() => {}} />);
  const input = () => screen.getByRole("textbox", { name: "Find a folder" }) as HTMLInputElement;
  return { store, listDirectories, findFolders, openWorkspace, input };
}

const results = () => screen.getByRole("listbox", { name: "Folders" });

describe("LocalFolderSource", () => {
  it("opens at the start folder with the repositories below it, marked by their host", async () => {
    const { findFolders } = renderSource();
    expect(await within(results()).findByRole("option", { name: "tau" })).toBeTruthy();
    expect(findFolders).toHaveBeenCalledWith("/repos");
    expect(within(results()).getByRole("button", { name: "_self" })).toBeTruthy();
    expect(within(results()).getByRole("option", { name: "notes" })).toBeTruthy();
    expect(within(results()).getByTitle("GitLab")).toBeTruthy();
    expect(within(results()).queryByTitle("git")).toBeNull();
  });

  it("finds repositories first and adds the highlighted one with Enter", async () => {
    const { openWorkspace, input } = renderSource();
    await within(results()).findByRole("option", { name: "tau" });
    fireEvent.change(input(), { target: { value: "tau" } });
    // The matched letters are a <mark>, which splits the accessible name.
    const match = await waitFor(() => {
      const found = within(results()).getAllByRole("option").find((option) => option.textContent === "_self/tau");
      if (!found) throw new Error("no match for _self/tau yet");
      return found;
    });
    expect(match.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(openWorkspace).toHaveBeenCalledWith("ws-tau"));
  });

  it("opens a folder with Tab and goes back up with Backspace", async () => {
    const { listDirectories, input } = renderSource();
    await within(results()).findByRole("option", { name: "tau" });
    fireEvent.keyDown(input(), { key: "2", metaKey: true });
    await within(results()).findByRole("option", { name: "_self" });
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Tab" });
    await waitFor(() => expect(listDirectories).toHaveBeenLastCalledWith("/repos/_self"));
    expect(await screen.findByRole("button", { name: "_self" })).toBeTruthy();
    fireEvent.keyDown(input(), { key: "Backspace" });
    await waitFor(() => expect(listDirectories).toHaveBeenLastCalledWith("/repos"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "_self" })?.closest(".folder-crumbs")).toBeFalsy());
  });

  it("lists a typed path and adds it with Enter", async () => {
    const { openWorkspace, input } = renderSource();
    await within(results()).findByRole("option", { name: "tau" });
    fireEvent.change(input(), { target: { value: "~/" } });
    await within(results()).findByRole("option", { name: "Documents" });
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(openWorkspace).toHaveBeenCalledWith("ws-home"));
  });

  it("makes the folder on screen the start folder from the pin's menu", async () => {
    const { store, findFolders } = renderSource();
    fireEvent.click(await within(results()).findByRole("button", { name: "_self" }));
    await within(results()).findByRole("option", { name: "intranet" });
    fireEvent.click(screen.getByRole("button", { name: "Start folder" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Start here/u }));
    await waitFor(() => expect(store.projectBaseDirectory()).toBe("/repos/_self"));
    await waitFor(() => expect(findFolders).toHaveBeenCalledWith("/repos/_self"));
  });
});
