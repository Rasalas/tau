// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalRowStatus, openShells, shellLabel } from "./row-status.js";
import { terminalStore } from "./store.js";

afterEach(() => { cleanup(); terminalStore.forgetSessions(); });

const shell = (id: string, sessionId?: string, exitCode?: number) => ({ id, label: id, cols: 80, rows: 24, ...(sessionId ? { sessionId } : {}), ...(exitCode === undefined ? {} : { exitCode }) });

describe("the terminal mark on a rail row", () => {
  it("counts the shells a thread opened that still run", () => {
    expect(openShells([shell("1", "a"), shell("2", "a", 0), shell("3", "b"), shell("4")], "a")).toBe(1);
    expect(shellLabel(2)).toBe("2 terminals open");
  });

  it("appears while the thread has a shell and goes when it exits", () => {
    const view = render(<TerminalRowStatus session={{ id: "a" }} />);
    expect(view.container.textContent).toBe("");
    act(() => terminalStore.setSessions([shell("1", "a"), shell("2", "a")]));
    const mark = view.getByRole("img", { name: "2 terminals open" });
    expect(mark.textContent).toBe("2");
    act(() => terminalStore.setSessions([shell("1", "a", 1), shell("2", "a", 0)]));
    expect(view.queryByRole("img")).toBeNull();
  });
});
