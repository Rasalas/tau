import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "./client-storage";
import { EMPTY_STAGE, openFileTab, openPanelTab, openThreadTab, type StageState } from "./stage";
import { stageStateKey } from "./storage-keys";
import {
  EMPTY_DOCK,
  pruneStageState,
  readDockState,
  readStageState,
  shownPanel,
  writeDockState,
  writeStageState,
} from "./workbench-layout-state";

const workspace = "workspace-1";

describe("stage persistence", () => {
  it("round-trips tabs and the active one", () => {
    const storage = createMemoryStorage();
    let stage: StageState = openFileTab(EMPTY_STAGE, "/repo/a.ts", { pin: true });
    stage = openThreadTab(stage, "thread-9", { pin: true });
    stage = openFileTab(stage, "/repo/b.ts", { view: "diff" });
    writeStageState(storage, workspace, stage);

    expect(readStageState(storage, workspace)).toEqual(stage);
  });

  it("starts empty for a workspace it has not seen, and forgets an emptied stage", () => {
    const storage = createMemoryStorage();
    expect(readStageState(storage, workspace)).toEqual(EMPTY_STAGE);

    writeStageState(storage, workspace, openFileTab(EMPTY_STAGE, "/repo/a.ts"));
    writeStageState(storage, workspace, EMPTY_STAGE);
    expect(storage.get(stageStateKey(workspace))).toBeNull();
  });

  it("keeps a tab kind it does not know and drops one it cannot read", () => {
    const storage = createMemoryStorage();
    storage.set(stageStateKey(workspace), JSON.stringify({
      tabs: [
        { id: "ext:1", kind: "extension", preview: false, params: { url: "https://example.test" } },
        { id: "file:/repo/a.ts", kind: "file", preview: false, path: "/repo/a.ts", view: "source" },
        { id: "broken", kind: "file", preview: false },
        { kind: "thread", preview: false, sessionId: "no-id" },
      ],
      activeId: "gone",
    }));

    const restored = readStageState(storage, workspace);
    expect(restored.tabs.map((tab) => tab.id)).toEqual(["ext:1", "file:/repo/a.ts"]);
    // An active id nothing answers falls back to the first tab rather than to none.
    expect(restored.activeId).toBe("ext:1");
  });

  it("keeps an extension tab whose kit has not activated yet, fields and all", () => {
    const storage = createMemoryStorage();
    const tab = { id: "ext:preview:1", kind: "extension", tabKind: "tau.preview/page", params: { url: "http://localhost:5173" }, preview: false, title: "Preview", dirty: true };
    storage.set(stageStateKey(workspace), JSON.stringify({ tabs: [tab], activeId: tab.id }));

    const restored = readStageState(storage, workspace);
    expect(restored.tabs).toEqual([tab]);
    expect(pruneStageState(restored, { workspacePath: "/repo", knownThreadIds: new Set() })).toBe(restored);
  });

  it("round-trips a maximized panel's tab and drops one without a panel id", () => {
    const storage = createMemoryStorage();
    const stage = openPanelTab(openFileTab(EMPTY_STAGE, "/repo/a.ts", { pin: true }), "tau.changes");
    writeStageState(storage, workspace, stage);
    expect(readStageState(storage, workspace)).toEqual(stage);
    storage.set(stageStateKey(workspace), JSON.stringify({ tabs: [{ id: "panel:", kind: "panel", preview: false }] }));
    expect(readStageState(storage, workspace)).toEqual(EMPTY_STAGE);
  });

  it("survives a value that is not JSON", () => {
    const storage = createMemoryStorage();
    storage.set(stageStateKey(workspace), "{not json");
    expect(readStageState(storage, workspace)).toEqual(EMPTY_STAGE);
  });
});

describe("pruneStageState", () => {
  const stage = (() => {
    let value: StageState = openFileTab(EMPTY_STAGE, "/repo/a.ts", { pin: true });
    value = openFileTab(value, "/elsewhere/b.ts", { pin: true });
    value = openThreadTab(value, "thread-live", { pin: true });
    return openThreadTab(value, "thread-gone", { pin: true });
  })();

  it("drops a file of another project and a thread the index forgot", () => {
    const pruned = pruneStageState(stage, {
      workspacePath: "/repo",
      knownThreadIds: new Set(["thread-live"]),
    });
    expect(pruned.tabs.map((tab) => tab.id)).toEqual(["file:/repo/a.ts", "thread:thread-live"]);
  });

  it("leaves threads alone until the index has arrived", () => {
    const pruned = pruneStageState(stage, { workspacePath: "/repo" });
    expect(pruned.tabs.map((tab) => tab.id)).toEqual(["file:/repo/a.ts", "thread:thread-live", "thread:thread-gone"]);
  });

  it("keeps a path the document source spelled relative to the workspace", () => {
    const relative = openFileTab(EMPTY_STAGE, "docs/CORE.md", { pin: true });
    expect(pruneStageState(relative, { workspacePath: "/repo" }).tabs).toHaveLength(1);
  });

  it("returns the same state when nothing is dropped", () => {
    expect(pruneStageState(stage, {})).toBe(stage);
  });

  it("moves the active id when the active tab is dropped", () => {
    const pruned = pruneStageState({ ...stage, activeId: "thread:thread-gone" }, { knownThreadIds: new Set(["thread-live"]) });
    expect(pruned.activeId).toBe("file:/repo/a.ts");
  });
});

describe("dock persistence", () => {
  it("round-trips which panels are open and how wide the dock is", () => {
    const storage = createMemoryStorage();
    writeDockState(storage, workspace, { open: true, activePanel: "tau.agents", openedPanels: ["tau.agents", "tau.terminal"], width: 380 });

    expect(readDockState(storage, workspace)).toEqual({
      open: true, activePanel: "tau.agents", openedPanels: ["tau.agents", "tau.terminal"], width: 380,
    });
  });

  it("keeps which drawer panel was open, and drops a drawer that is not a panel id", () => {
    const storage = createMemoryStorage();
    writeDockState(storage, workspace, { open: false, openedPanels: [], drawer: "terminal" });
    expect(readDockState(storage, workspace).drawer).toBe("terminal");
    storage.set(`tau.dock.v1:${workspace}`, JSON.stringify({ open: false, openedPanels: [], drawer: 3 }));
    expect(readDockState(storage, workspace)).toEqual(EMPTY_DOCK);
  });

  it("starts closed for a workspace it has not seen", () => {
    expect(readDockState(createMemoryStorage(), workspace)).toEqual(EMPTY_DOCK);
  });
});

describe("shownPanel", () => {
  it("shows the chosen panel once a kit offers it", () => {
    expect(shownPanel("terminal", ["agents", "terminal"])).toBe("terminal");
  });

  it("stands in with the first offered panel while the chosen one is missing", () => {
    expect(shownPanel("terminal", ["agents"])).toBe("agents");
    expect(shownPanel(undefined, ["agents"])).toBe("agents");
    expect(shownPanel("terminal", [])).toBe("");
  });
});
