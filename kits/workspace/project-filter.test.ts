import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage, setClientStorage } from "../../src/renderer/test-support/kit-harness.js";
import { PreferencesStore } from "../../src/renderer/preferences.js";
import type { WorkbenchActions } from "tau";
import { createWorkspaceHostClient } from "./protocol.js";
import { WorkspaceStore } from "./store.js";
import { NO_PROJECT, PROJECT_FILTER_KEY, matchingGroup, projectFilterIncludes, readProjectFilter } from "./project-filter.js";

const projects = [
  { name: "app", path: "/repos/app", workspaceId: "ws1_local_app", lastOpenedAt: 1 },
  { name: "app", path: "/other/app", workspaceId: "ws1_other_app", lastOpenedAt: 2 },
];
const thread = { projectName: "app", projectPath: "/repos/app", workspaceId: "ws1_local_app" };
afterEach(() => setClientStorage(undefined));

describe("project selections", () => {
  it("keeps identities apart even with the same name and path on another machine", () => {
    const selected = ["ws1_local_app"];
    expect(projectFilterIncludes(selected, thread, projects)).toBe(true);
    expect(projectFilterIncludes(selected, { ...thread, workspaceId: "ws1_remote_app" }, projects)).toBe(false);
    expect(projectFilterIncludes(selected, { ...thread, workspaceId: "ws1_other_app", projectPath: "/other/app" }, projects)).toBe(false);
  });

  it("recognizes legacy worktree paths but classifies private workspaces explicitly", () => {
    expect(projectFilterIncludes(["ws1_local_app"], { projectName: "app", projectPath: "/repos/app/worktrees/fix" }, projects)).toBe(true);
    expect(projectFilterIncludes([NO_PROJECT], { ...thread, projectless: true }, projects)).toBe(true);
    expect(projectFilterIncludes([NO_PROJECT], { projectName: "unknown", projectPath: "/unlisted" }, projects)).toBe(false);
    expect(projectFilterIncludes(["ws1_local_app"], { ...thread, projectless: true }, projects)).toBe(false);
  });

  it("distinguishes all projects from an explicitly empty selection and recognizes groups after a rename", () => {
    expect(projectFilterIncludes(undefined, thread, projects)).toBe(true);
    expect(projectFilterIncludes([], thread, projects)).toBe(false);
    const groups = [{ id: "product", name: "Product", projects: ["ws1_local_app", NO_PROJECT] }];
    expect(matchingGroup([NO_PROJECT, "ws1_local_app"], groups, [{ ...projects[0]!, name: "new name" }])?.id).toBe("product");
  });
});

describe("remembered project groups", () => {
  const createStore = () => new WorkspaceStore(new PreferencesStore(), createWorkspaceHostClient(async () => undefined));

  it("restores the filter and groups, and keeps a saved group unchanged when its live selection changes", () => {
    const storage = createMemoryStorage(); setClientStorage(storage);
    const store = createStore();
    store.setRailProjectFilter(["ws1_local_app", NO_PROJECT]);
    expect(store.saveRailProjectGroup("Product", ["ws1_local_app", NO_PROJECT])).toBe(true);
    const id = store.getSnapshot().railProjectGroups[0]!.id;
    store.setRailProjectFilter([]);
    const restored = createStore();
    expect(restored.getSnapshot().railProjectFilter).toEqual([]);
    expect(restored.getSnapshot().railProjectGroups[0]).toEqual({ id, name: "Product", projects: ["ws1_local_app", NO_PROJECT] });
    expect(restored.saveRailProjectGroup("Renamed", ["ws1_local_app", NO_PROJECT], id)).toBe(true);
    expect(createStore().getSnapshot().railProjectGroups[0]?.name).toBe("Renamed");
    restored.removeRailProjectGroup(id);
    expect(createStore().getSnapshot().railProjectGroups).toEqual([]);
    expect(createStore().getSnapshot().railProjectFilter).toEqual([]);
  });

  it("reports failed persistence instead of pretending the group was saved", () => {
    const storage = createMemoryStorage(); setClientStorage(storage);
    const store = createStore(); const notify = vi.fn(); store.bind({ notify } as unknown as WorkbenchActions);
    storage.set = () => { throw new Error("quota"); };
    expect(store.saveRailProjectGroup("Product", ["ws1_local_app"])).toBe(false);
    expect(store.getSnapshot().railProjectGroups).toEqual([]);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("could not be saved"), "error");
  });

  it("ignores invalid persisted entries without losing a deliberate empty filter", () => {
    const storage = createMemoryStorage();
    storage.set(PROJECT_FILTER_KEY, JSON.stringify({ filter: [], groups: [null, { id: "bad", name: "Bad", projects: [123] }, { id: "good", name: " Good ", projects: ["ws1_local_app", "ws1_local_app"] }] }));
    expect(readProjectFilter(storage)).toEqual({ filter: [], groups: [{ id: "good", name: "Good", projects: ["ws1_local_app"] }] });
  });
});
