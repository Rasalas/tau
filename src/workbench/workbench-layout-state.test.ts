import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "./client-storage";
import { EMPTY_STAGE, openFileTab, openPanelTab, openThreadTab, type StageState } from "./stage";
import { stageStateKey } from "./storage-keys";
import {
  EMPTY_DOCK,
  decodeStageState,
  pruneStageState,
  readDockState,
  readStageState,
  mergeDock,
  shownPanel,
  takeProjectLayout,
  writeDockState,
} from "./workbench-layout-state";

const workspace = "workspace-1";

function writeStageState(storage: ReturnType<typeof createMemoryStorage>, key: string, stage: StageState): void {
  storage.set(stageStateKey(key), JSON.stringify(stage));
}

describe("stage persistence", () => {
  it("round-trips tabs and the active one", () => {
    const storage = createMemoryStorage();
    let stage: StageState = openFileTab(EMPTY_STAGE, "/repo/a.ts", { pin: true });
    stage = openThreadTab(stage, "thread-9", { pin: true });
    stage = openFileTab(stage, "/repo/b.ts", { view: "diff" });
    writeStageState(storage, workspace, stage);

    expect(readStageState(storage, workspace)).toEqual(stage);
  });

  it("starts empty for a workspace it has not seen", () => {
    expect(readStageState(createMemoryStorage(), workspace)).toEqual(EMPTY_STAGE);
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

  it("keeps another machine's thread, which this index never lists", () => {
    const remote = openThreadTab(EMPTY_STAGE, "t9", { pin: true, machine: "host-rex" });
    expect(pruneStageState(remote, { knownThreadIds: new Set() })).toBe(remote);
    expect(decodeStageState(JSON.parse(JSON.stringify(remote)))).toEqual(remote);
    expect(decodeStageState({ tabs: [{ ...remote.tabs[0], machine: 7 }] }).tabs).toEqual([]);
  });

  it("restores a split, and forgets one whose tab is gone or in front", () => {
    const tabs = [{ id: "file:a", kind: "file", path: "a", view: "source", preview: false }, { id: "file:b", kind: "file", path: "b", view: "source", preview: false }];
    expect(decodeStageState({ tabs, activeId: "file:a", splitId: "file:b" }).splitId).toBe("file:b");
    expect(decodeStageState({ tabs, activeId: "file:a", splitId: "file:a" }).splitId).toBeUndefined();
    expect(decodeStageState({ tabs, activeId: "file:a", splitId: "file:c" }).splitId).toBeUndefined();
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
  it("keeps the project's part of the dock: mounted panels, the last pick and the width", () => {
    const storage = createMemoryStorage();
    writeDockState(storage, workspace, { open: true, activePanel: "tau.agents", openedPanels: ["tau.agents", "tau.terminal"], width: 380, drawer: "terminal" });

    expect(readDockState(storage, workspace)).toEqual({
      open: false, activePanel: "tau.agents", openedPanels: ["tau.agents", "tau.terminal"], width: 380,
    });
  });

  it("puts a thread's open dock and drawer over its project's, and starts a thread without one closed", () => {
    const project = { open: false, activePanel: "files", openedPanels: ["files"], width: 380 };
    expect(mergeDock(project, { open: true, activePanel: "terminal", drawer: "logs" })).toEqual({
      open: true, activePanel: "terminal", openedPanels: ["files"], width: 380, drawer: "logs",
    });
    expect(mergeDock(project, undefined)).toEqual({ open: false, activePanel: "files", openedPanels: ["files"], width: 380 });
  });

  it("drops a drawer that is not a panel id", () => {
    const storage = createMemoryStorage();
    storage.set(`tau.dock.v1:${workspace}`, JSON.stringify({ open: false, openedPanels: [], drawer: 3 }));
    expect(readDockState(storage, workspace)).toEqual(EMPTY_DOCK);
  });

  it("starts closed for a workspace it has not seen", () => {
    expect(readDockState(createMemoryStorage(), workspace)).toEqual(EMPTY_DOCK);
  });

  it("hands the project's old stage, open dock and drawer over once, and keeps them until then", () => {
    const storage = createMemoryStorage();
    const stage = openFileTab(EMPTY_STAGE, "src/a.ts", { pin: true });
    writeStageState(storage, workspace, stage);
    storage.set(`tau.dock.v1:${workspace}`, JSON.stringify({ open: true, activePanel: "files", openedPanels: ["files"], drawer: "terminal" }));
    writeDockState(storage, workspace, { open: false, activePanel: "files", openedPanels: ["files"], width: 300 });

    expect(takeProjectLayout(storage, workspace)).toEqual({ stage, dock: { open: true, activePanel: "files", drawer: "terminal" } });
    expect(JSON.parse(storage.get(`tau.dock.v1:${workspace}`) ?? "{}")).toEqual({ activePanel: "files", openedPanels: ["files"], width: 300 });
    expect(takeProjectLayout(storage, workspace)).toBeUndefined();
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
