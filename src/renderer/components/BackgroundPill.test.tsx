// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiBackgroundTask } from "../../shared/contracts";
import { installPointerEvents } from "../test-support/pointer-events";
import { BackgroundPill } from "./BackgroundPill";

installPointerEvents();
afterEach(cleanup);

const monitor: UiBackgroundTask = { id: "b1", kind: "monitor", label: "Nightly run 37995249714", startedAt: Date.UTC(2026, 9, 9, 21, 52) };
const server: UiBackgroundTask = { id: "b2", kind: "command", label: "npm run dev" };

function open(tasks: UiBackgroundTask[], options: { readOnly?: boolean; onStop?: (taskId?: string) => Promise<void> } = {}) {
  const onStop = vi.fn(options.onStop ?? (async () => undefined));
  render(<BackgroundPill tasks={tasks} runtime="Claude Code" readOnly={options.readOnly ?? false} onStop={onStop} />);
  fireEvent.click(screen.getByRole("button", { name: /in the background/u }));
  return { onStop, dialog: () => screen.getByRole("dialog", { name: "Background work" }) };
}

describe("BackgroundPill", () => {
  it("says Monitoring, lists each task and stops one", async () => {
    const { dialog, onStop } = open([monitor, server]);
    const pill = screen.getByRole("button", { name: /^1 monitor and 1 command in the background/u });
    expect(pill.className).toContain("holds");
    expect(pill.textContent).toBe("Monitoring2");
    expect(dialog().textContent).toContain("Nightly run 37995249714");
    expect(dialog().textContent).toContain("Monitor · since");
    expect(dialog().textContent).toContain("Claude Code continues when this work reports.");
    fireEvent.click(screen.getByRole("button", { name: "Stop npm run dev" }));
    await waitFor(() => expect(onStop).toHaveBeenCalledWith("b2"));
    await waitFor(() => expect((screen.getByRole("button", { name: "Stop all" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Stop all" }));
    await waitFor(() => expect(onStop).toHaveBeenLastCalledWith(undefined));
  });

  it("says Waiting for required commands and offers no Stop all for one", () => {
    const { dialog } = open([server]);
    const pill = screen.getByRole("button", { name: /^1 command in the background/u });
    expect(pill.className).toContain("holds");
    expect(pill.textContent).toBe("Waiting");
    expect(dialog().textContent).toContain("The request remains open until the results are handled.");
    expect(screen.queryByRole("button", { name: "Stop all" })).toBeNull();
  });

  it("keeps a released service quiet, but keeps an unhandled result open", () => {
    let opened = open([{ ...server, blocksCompletion: false }]);
    expect(screen.getByRole("button", { name: /in the background/u }).className).not.toContain("holds");
    expect(opened.dialog().textContent).toContain("These checked services keep running independently.");
    cleanup();
    opened = open([{ ...server, state: "reported" }]);
    expect(screen.getByRole("button", { name: /in the background/u }).textContent).toBe("Waiting");
    expect(opened.dialog().textContent).toContain("Result ready");
    expect(opened.dialog().textContent).toContain("Claude Code still needs to handle the result.");
  });

  it("shows why a stop failed and stops nothing from a read-only device", async () => {
    open([monitor], { onStop: async () => { throw new Error("That background task is no longer running."); } });
    fireEvent.click(screen.getByRole("button", { name: "Stop Nightly run 37995249714" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That background task is no longer running.");
    cleanup();
    open([monitor], { readOnly: true });
    expect((screen.getByRole("button", { name: "Stop Nightly run 37995249714" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
