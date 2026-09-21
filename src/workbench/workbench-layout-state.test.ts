import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "./client-storage";
import { EMPTY_STAGE, openFileTab, openThreadTab, type StageState } from "./stage";
import { stageStateKey } from "./storage-keys";
import {
  EMPTY_DOCK,
  pruneStageState,
  readDockState,
  readStageState,
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

  it("starts closed for a workspace it has not seen", () => {
    expect(readDockState(createMemoryStorage(), workspace)).toEqual(EMPTY_DOCK);
  });
});
