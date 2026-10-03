import { describe, expect, it, vi } from "vitest";
import type { PaletteSearchContext, WorkbenchActions } from "tau";
import { addProjectMenu, CLONE_SOURCE, folderMenu, type AddProjectHost } from "./add-project-menu.js";

const ref = (path: string) => ({ workspaceId: `ws:${path}`, path, local: true }) as never;

function fixture(base?: string): AddProjectHost & { listDirectories: ReturnType<typeof vi.fn> } {
  return {
    listDirectories: vi.fn(async (path?: string) => {
      const at = path ?? "/Users/me";
      if (at === "/gone") throw new Error("ENOENT");
      return { path: at, workspace: ref(at), parent: "/Users", directories: [{ name: "tau", path: `${at}/tau` }, { name: "orbit", path: `${at}/orbit` }] };
    }),
    pickFolder: vi.fn(async () => ref("/picked")),
    baseDirectory: () => base,
  };
}

const search = { actions: {} as WorkbenchActions, index: { projects: [], threads: [] }, signal: new AbortController().signal } as PaletteSearchContext;

describe("the add-project levels", () => {
  it("offers browsing from the base folder, the native picker and clone", async () => {
    const host = fixture("~/code");
    const items = await addProjectMenu(host).items("", search);
    expect(items.map((item) => item.label)).toEqual(["New project…", "Browse folders", "Choose a folder…", "Clone Git repository"]);
    expect(items[1]!.submenu?.title).toBe("code");

    const actions = { openProjectSources: vi.fn(), openWorkspace: vi.fn(async () => true), notify: vi.fn() } as unknown as WorkbenchActions;
    await items[3]!.run!(actions);
    expect(actions.openProjectSources).toHaveBeenCalledWith(CLONE_SOURCE);
    await items[2]!.run!(actions);
    expect(actions.openWorkspace).toHaveBeenCalledWith("ws:/picked");
  });

  it("lists a folder once: add it, go up, or drill into one inside it", async () => {
    const host = fixture();
    const level = folderMenu(host, "/Users/me");
    const items = await level.items("", search);
    await level.items("ta", search);
    expect(host.listDirectories).toHaveBeenCalledTimes(1);
    expect(items.map((item) => item.label)).toEqual(["Add me", "..", "tau", "orbit"]);
    expect(items[2]!.submenu?.title).toBe("tau");

    const actions = { openWorkspace: vi.fn(async () => false), notify: vi.fn() } as unknown as WorkbenchActions;
    await items[0]!.run!(actions);
    expect(actions.openWorkspace).toHaveBeenCalledWith("ws:/Users/me");
    expect(actions.notify).toHaveBeenCalledWith("That folder could not be opened as a project.");
  });

  it("falls back to the home folder when the base folder is gone, and fails on any other", async () => {
    const host = fixture("/gone");
    expect((await folderMenu(host, "/gone").items("", search))[0]!.detail).toBe("/Users/me");
    await expect(folderMenu(fixture(), "/gone").items("", search)).rejects.toThrow("ENOENT");
  });
});
