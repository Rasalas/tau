import { describe, expect, it } from "vitest";
import { chipLabels, needsFirstShell, tabTitle, threadScope } from "./scope.js";
import type { TerminalLayout } from "./layout.js";
import type { UiTerminalSession } from "./protocol.js";

const shell = (id: string, sessionId?: string): UiTerminalSession => ({ id, label: `${id} — shell`, cols: 80, rows: 24, ...(sessionId ? { sessionId } : {}) });
const tab = (id: string) => ({ id: `g-${id}`, root: { kind: "pane" as const, id }, focused: id });

describe("a thread's view of the panel", () => {
  const sessions = [shell("mine", "s1"), shell("theirs", "s2"), shell("project")];
  const layout: TerminalLayout = { groups: [tab("mine"), tab("theirs"), tab("project")], stage: [], active: "g-theirs" };

  it("shows the thread's and the project's tabs and keeps another thread's aside", () => {
    const scope = threadScope(layout, sessions, "s1");
    expect(scope.shown.map((group) => group.id)).toEqual(["g-mine", "g-project"]);
    expect(scope.elsewhere.map((group) => group.id)).toEqual(["g-theirs"]);
    // Another thread left its tab active; this one shows its own last tab.
    expect(scope.current?.id).toBe("g-project");
  });

  it("shows another thread's tab here once it is picked", () => {
    const scope = threadScope(layout, sessions, "s1", "g-theirs");
    expect(scope.shown.map((group) => group.id)).toEqual(["g-mine", "g-theirs", "g-project"]);
    expect(scope.current?.id).toBe("g-theirs");
  });

  it("counts a shell the host has not listed yet as the thread's own", () => {
    expect(threadScope({ groups: [tab("new")], stage: [] }, [], "s1").shown).toHaveLength(1);
  });

  it("wants a first shell only when the thread has none, in the panel or on the stage", () => {
    expect(needsFirstShell(threadScope({ groups: [tab("theirs")], stage: [] }, sessions, "s1"))).toBe(true);
    expect(needsFirstShell(threadScope({ groups: [tab("theirs")], stage: [tab("mine")] }, sessions, "s1"))).toBe(false);
    expect(needsFirstShell(threadScope(layout, sessions, "s1"))).toBe(false);
  });
});

describe("tab names", () => {
  it("drops the shell suffix of a directory's name and numbers names two tabs share", () => {
    expect(tabTitle("workspace — shell")).toBe("workspace");
    expect(tabTitle("npm test")).toBe("npm test");
    const names = chipLabels([{ id: "a", label: "workspace" }, { id: "b", label: "src" }, { id: "c", label: "workspace" }]);
    expect([...names.values()]).toEqual(["workspace 1", "src", "workspace 2"]);
  });
});
