// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiThreadGoal } from "../../shared/contracts";
import { installPointerEvents } from "../test-support/pointer-events";
import { goalCommandRefusal, showGoal } from "../goal-state";
import { GoalPill, READ_ONLY_GOAL, compactTokens } from "./GoalPill";

installPointerEvents();
afterEach(() => { cleanup(); showGoal(undefined, undefined, false); });

const goal = (status: UiThreadGoal["status"], extra: Partial<UiThreadGoal> = {}): UiThreadGoal => ({
  objective: "Make the smoke check pass", status, actions: { pause: true, resume: true }, tokensUsed: 41_200, turns: 3, updatedAt: 1, ...extra,
});

function open(value: UiThreadGoal, options: { readOnly?: boolean; onAction?: (action: string) => Promise<void> } = {}) {
  const onAction = vi.fn(options.onAction ?? (async () => undefined));
  render(<GoalPill goal={value} runtime="Codex" readOnly={options.readOnly ?? false} onAction={onAction} />);
  fireEvent.click(screen.getByRole("button", { name: /goal/iu }));
  return { onAction, dialog: () => screen.getByRole("dialog", { name: "Goal" }) };
}

describe("GoalPill", () => {
  it("runs blue with its tokens, opens on a click and puts Pause, the safe action, under the keyboard", async () => {
    const { dialog, onAction } = open(goal("active"));
    const pill = screen.getByRole("button", { name: "Pursuing goal: Make the smoke check pass" });
    expect(pill.className).toContain("running");
    expect(pill.getAttribute("aria-haspopup")).toBe("dialog");
    expect(pill.getAttribute("aria-expanded")).toBe("true");
    expect(pill.textContent).toBe("Goal41.2k");
    expect(dialog().textContent).toContain("Codex starts the next turn on its own until the goal is met. Pause lets the running turn finish.");
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Pause"));
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("pause"));
  });

  it("offers no Pause where the runtime has none, and takes the focus itself so Enter ends nothing", async () => {
    const { dialog } = open(goal("active", { actions: { pause: false, resume: false } }));
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(dialog().textContent).toContain("It can't pause a goal: Stop ends the turn and the goal stays set.");
    await waitFor(() => expect(document.activeElement?.classList.contains("goal-popover-body")).toBe(true));
  });

  it.each([
    ["paused", "Goal paused", "rest", ["Resume", "End goal"]],
    ["blocked", "Goal blocked", "waiting", ["Resume", "End goal"]],
    ["budget-limited", "Budget reached", "waiting", ["End goal"]],
    ["complete", "Goal met", "done", ["Done"]],
    ["unconfirmed", "Goal not confirmed", "waiting", ["Dismiss", "Resume"]],
  ] as const)("shows %s as %s, in its tone, with only its actions", (status, label, tone, actions) => {
    open(goal(status));
    const pill = screen.getAllByRole("button").find((button) => button.classList.contains("goal-pill"))!;
    expect(pill.textContent).toBe(label);
    expect(pill.className).toContain(tone);
    expect([...document.querySelectorAll(".goal-actions > button")].map((button) => button.textContent)).toEqual(actions);
  });

  it("never calls a goal without a verdict met", () => {
    const { dialog } = open(goal("unconfirmed"));
    expect(dialog().textContent).toContain("Codex stopped without a verdict. Tau doesn't know whether the goal is met; check the result before relying on it.");
    expect(document.querySelector(".goal-pill")?.className).not.toContain("done");
  });

  it("disables every action on a Read-only device and says why", () => {
    open(goal("paused"), { readOnly: true });
    for (const button of document.querySelectorAll<HTMLButtonElement>(".goal-actions > button")) expect(button.disabled).toBe(true);
    expect(screen.getByText(READ_ONLY_GOAL)).toBeTruthy();
  });

  it("says what went wrong in the popover and keeps it open", async () => {
    open(goal("paused"), { onAction: async () => { throw new Error("Codex is not running."); } });
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Codex is not running."));
  });

  it("writes tokens short", () => {
    expect([compactTokens(950), compactTokens(41_200), compactTokens(1_000), compactTokens(2_300_000)]).toEqual(["950", "41.2k", "1k", "2.3M"]);
  });
});

describe("goal commands", () => {
  it("are refused with a reason unless they fit the goal on screen", () => {
    showGoal("t", undefined, false);
    expect(goalCommandRefusal("pause")).toBe("This thread's runtime keeps no goals.");
    showGoal("t", undefined, true);
    expect(goalCommandRefusal("end")).toBe("This thread has no goal.");
    showGoal("t", goal("active", { actions: { pause: false, resume: false } }), true);
    expect(goalCommandRefusal("pause")).toBe("This runtime cannot pause a goal.");
    expect(goalCommandRefusal("resume")).toBe("The goal cannot be resumed now.");
    showGoal("t", goal("paused"), true);
    expect(goalCommandRefusal("resume")).toBeUndefined();
    expect(goalCommandRefusal("pause")).toBe("The goal is not running.");
  });
});
