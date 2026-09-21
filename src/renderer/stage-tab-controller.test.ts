// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { EMPTY_STAGE, extensionTabId, openFileTab, type StageState } from "../workbench/stage";
import { ExtensionRegistry, type DesktopExtension, type StageTabContribution } from "./extension-system";
import { StageTabController } from "./stage-tab-controller";

const TERMINAL = extensionTabId("terminal", '{"id":"t1"}');

function kit(tab: Partial<StageTabContribution> = {}): DesktopExtension {
  return {
    id: "acme.terminals",
    name: "Terminals",
    activate(plugin) {
      plugin.registerStageTab({
        kind: "terminal",
        title: (params) => `shell ${String(params.id)}`,
        render: () => null,
        ...tab,
      });
    },
  };
}

function harness(initial: StageState = EMPTY_STAGE) {
  const registry = new ExtensionRegistry();
  let stage = initial;
  const confirmDiscard = vi.fn(() => true);
  const controller = new StageTabController({
    registry,
    stage: () => stage,
    setStage: (change) => { stage = typeof change === "function" ? change(stage) : change; },
    confirmDiscard,
  });
  return { registry, controller, confirmDiscard, get stage() { return stage; } };
}

describe("stage tabs a kit draws", () => {
  it("opens one tab per params and reopens it instead of a second one", () => {
    const app = harness();
    app.registry.activate(kit());

    const id = app.controller.open("terminal", { id: "t1" });
    app.controller.open("terminal", { id: "t1" });
    app.controller.open("terminal", { id: "t2" });

    expect(id).toBe(TERMINAL);
    expect(app.stage.tabs.map((tab) => tab.id)).toEqual([TERMINAL, extensionTabId("terminal", '{"id":"t2"}')]);
    expect(app.stage.tabs[0]).toMatchObject({ kind: "extension", tabKind: "terminal", title: "shell t1", preview: false });
  });

  it("gives a singleton kind one tab whatever it is opened with", () => {
    const app = harness();
    app.registry.activate(kit({ singleton: true }));

    app.controller.open("terminal", { id: "t1" });
    app.controller.open("terminal", { id: "t2" });

    expect(app.stage.tabs).toHaveLength(1);
    expect(app.stage.tabs[0]).toMatchObject({ id: extensionTabId("terminal", ""), title: "shell t2" });
  });

  it("refuses a kind nobody registered", () => {
    const app = harness();
    expect(() => app.controller.open("terminal", {})).toThrow(/not registered/u);
  });

  it("renames and marks its own tab through the handle it was given", () => {
    const app = harness();
    app.registry.activate(kit());
    const id = app.controller.open("terminal", { id: "t1" });
    const handle = app.controller.handle(id);

    expect(app.controller.handle(id)).toBe(handle);
    handle.setTitle("shell t1 · building");
    handle.setDirty(true);

    expect(app.stage.tabs[0]).toMatchObject({ title: "shell t1 · building", dirty: true });
  });

  it("asks before closing a tab with unsaved work and keeps it when the answer is no", () => {
    const app = harness();
    app.registry.activate(kit());
    const id = app.controller.open("terminal", { id: "t1" });
    app.controller.handle(id).setDirty(true);
    app.confirmDiscard.mockReturnValue(false);

    app.controller.close(id);
    expect(app.stage.tabs).toHaveLength(1);
    expect(app.confirmDiscard).toHaveBeenCalledWith("shell t1");

    app.confirmDiscard.mockReturnValue(true);
    app.controller.close(id);
    expect(app.stage.tabs).toEqual([]);
  });

  it("runs the tab's own close listeners whoever closed it, once", () => {
    const app = harness();
    app.registry.activate(kit());
    const closed = vi.fn();
    const id = app.controller.open("terminal", { id: "t1" });
    app.controller.handle(id).onClose(closed);

    app.controller.closeActive();
    expect(closed).toHaveBeenCalledOnce();

    app.controller.close(id);
    expect(closed).toHaveBeenCalledOnce();
  });

  it("closes the others and the ones to the right, firing their listeners", () => {
    const app = harness(openFileTab(EMPTY_STAGE, "/repo/a.ts", { pin: true }));
    app.registry.activate(kit());
    const first = app.controller.open("terminal", { id: "t1" });
    const second = app.controller.open("terminal", { id: "t2" });
    const closed = vi.fn();
    app.controller.handle(second).onClose(closed);

    app.controller.closeToTheRight(first);
    expect(closed).toHaveBeenCalledOnce();
    expect(app.stage.tabs.map((tab) => tab.id)).toEqual(["file:/repo/a.ts", first]);

    app.controller.closeOthers(first);
    expect(app.stage.tabs.map((tab) => tab.id)).toEqual([first]);
  });
});

describe("a stage tab whose kind is not there", () => {
  it("goes when the kit that drew it goes, without asking about unsaved work", () => {
    const app = harness();
    const extension = kit();
    app.registry.activate(extension);
    const closed = vi.fn();
    const id = app.controller.open("terminal", { id: "t1" });
    app.controller.handle(id).onClose(closed);
    app.controller.handle(id).setDirty(true);
    app.controller.syncKinds();

    app.registry.deactivate(extension.id);
    app.controller.syncKinds();

    expect(app.stage.tabs).toEqual([]);
    expect(app.confirmDiscard).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("waits for a kit that has not activated yet, so a restored tab survives the start", () => {
    const restored: StageState = {
      tabs: [{ id: TERMINAL, kind: "extension", tabKind: "terminal", params: { id: "t1" }, title: "shell t1", preview: false }],
      activeId: TERMINAL,
    };
    const app = harness(restored);

    app.controller.syncKinds();
    expect(app.stage.tabs).toHaveLength(1);

    app.registry.activate(kit());
    app.controller.syncKinds();
    expect(app.stage.tabs).toHaveLength(1);
  });

  it("drops a restored tab its kind no longer recognises, and asks only once", () => {
    const restored: StageState = {
      tabs: [{ id: TERMINAL, kind: "extension", tabKind: "terminal", params: { id: "t1" }, title: "shell t1", preview: false }],
      activeId: TERMINAL,
    };
    const app = harness(restored);
    const restore = vi.fn(() => false);
    app.registry.activate(kit({ restore }));

    app.controller.syncKinds();
    app.controller.syncKinds();

    expect(restore).toHaveBeenCalledExactlyOnceWith({ id: "t1" });
    expect(app.stage.tabs).toEqual([]);
  });
});
