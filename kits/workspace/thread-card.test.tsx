// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiSession, WorkbenchActions } from "tau";
import type { ThreadCardSection, ThreadCardSectionProps } from "./protocol.js";
import { cardPlacement, ThreadCard, ThreadCardHover, THREAD_CARD_CLOSE_DELAY_MS, THREAD_CARD_OPEN_DELAY_MS, type CardTimers } from "./thread-card.js";

afterEach(cleanup);

/** Timers that only move when the test says so. */
function manualTimers(): CardTimers & { advance(ms: number): void } {
  let now = 0;
  let next = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  return {
    set: (run, ms) => { next += 1; pending.set(next, { at: now + ms, run }); return next; },
    clear: (handle) => { pending.delete(handle as number); },
    advance(ms) {
      now += ms;
      for (const [handle, timer] of [...pending].sort((left, right) => left[1].at - right[1].at)) {
        if (timer.at > now) continue;
        pending.delete(handle);
        timer.run();
      }
    },
  };
}

function hover() {
  const timers = manualTimers();
  const shown: Array<string | undefined> = [];
  const controller = new ThreadCardHover((key) => shown.push(key), timers);
  return { timers, shown, controller };
}

describe("when a row's card opens and closes", () => {
  it("opens after the pointer rests on a row, and closes a moment after it leaves", () => {
    const { timers, shown, controller } = hover();
    controller.enterRow("a");
    timers.advance(THREAD_CARD_OPEN_DELAY_MS - 1);
    expect(controller.current()).toBeUndefined();
    timers.advance(1);
    expect(controller.current()).toBe("a");
    controller.leaveRow("a");
    timers.advance(THREAD_CARD_CLOSE_DELAY_MS - 1);
    expect(controller.current()).toBe("a");
    timers.advance(1);
    expect(shown).toEqual(["a", undefined]);
  });

  it("opens nothing while the pointer sweeps over the rail", () => {
    const { timers, shown, controller } = hover();
    for (const key of ["a", "b", "c", "d"]) {
      controller.enterRow(key);
      timers.advance(60);
      controller.leaveRow(key);
    }
    timers.advance(1_000);
    expect(shown).toEqual([]);
  });

  it("stays open while the pointer crosses to the card and rests on it", () => {
    const { timers, controller } = hover();
    controller.enterRow("a");
    timers.advance(THREAD_CARD_OPEN_DELAY_MS);
    controller.leaveRow("a");
    timers.advance(100);
    controller.enterCard();
    timers.advance(5_000);
    expect(controller.current()).toBe("a");
    controller.leave();
    timers.advance(THREAD_CARD_CLOSE_DELAY_MS);
    expect(controller.current()).toBeUndefined();
  });

  it("moves to another row only after the pointer rests there too", () => {
    const { timers, controller } = hover();
    controller.enterRow("a");
    timers.advance(THREAD_CARD_OPEN_DELAY_MS);
    controller.leaveRow("a");
    controller.enterRow("b");
    timers.advance(THREAD_CARD_OPEN_DELAY_MS - 1);
    expect(controller.current()).toBe("a");
    timers.advance(1);
    expect(controller.current()).toBe("b");
  });

  it("closes on a press and stays closed until the pointer leaves that row", () => {
    const { timers, controller } = hover();
    controller.enterRow("a");
    timers.advance(THREAD_CARD_OPEN_DELAY_MS);
    controller.press("a");
    expect(controller.current()).toBeUndefined();
    controller.enterRow("a");
    timers.advance(1_000);
    expect(controller.current()).toBeUndefined();
    controller.leaveRow("a");
    controller.enterRow("a");
    timers.advance(THREAD_CARD_OPEN_DELAY_MS);
    expect(controller.current()).toBe("a");
    // A row that moved away from under the pointer after the press (settled onto the shelf) is forgotten on leaving the list.
    controller.press("a");
    controller.leaveList();
    controller.enterRow("a");
    timers.advance(THREAD_CARD_OPEN_DELAY_MS);
    expect(controller.current()).toBe("a");
  });

  it("opens at once on keyboard focus, and closes when focus leaves, but not a card the pointer holds", () => {
    const { controller, timers } = hover();
    controller.focusRow("a");
    expect(controller.current()).toBe("a");
    controller.blurRow();
    expect(controller.current()).toBeUndefined();
    controller.enterRow("b");
    timers.advance(THREAD_CARD_OPEN_DELAY_MS);
    controller.blurRow();
    expect(controller.current()).toBe("b");
    controller.close();
    expect(controller.current()).toBeUndefined();
  });
});

describe("where the card goes", () => {
  it("sits right of the row, its top at the row's, inside the window", () => {
    const viewport = { width: 1_000, height: 800 };
    expect(cardPlacement({ top: 100, right: 256 }, { width: 300, height: 200 }, viewport)).toEqual({ left: 262, top: 100 });
    // A row near the bottom lifts the card; a narrow window pulls it in.
    expect(cardPlacement({ top: 700, right: 256 }, { width: 300, height: 200 }, viewport)).toEqual({ left: 262, top: 592 });
    expect(cardPlacement({ top: 100, right: 256 }, { width: 300, height: 200 }, { width: 500, height: 800 })).toEqual({ left: 192, top: 100 });
  });
});

const SESSION: UiSession = {
  id: "t1",
  path: "/sessions/t1.jsonl",
  title: "A title long enough that the rail cuts it short but the card does not",
  modifiedAt: Date.now(),
  projectPath: "/projects/tau",
  projectName: "tau",
  projectLabel: "fix/K59-thread-card",
  messageCount: 4,
  backendKind: "pi",
  modelProvider: "openai-codex",
  model: "gpt-5.6-luna",
  usage: { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_200, costUsd: 0.42, turns: 2 },
};

const actions = {} as WorkbenchActions;

function drawCard(props: Partial<Parameters<typeof ThreadCard>[0]> = {}) {
  const onClose = vi.fn();
  render(<div className="thread-card">
    <ThreadCard session={SESSION} activity="idle" age="5m" showCost sections={[]} actions={actions} onClose={onClose} {...props} />
  </div>);
  return { onClose };
}

const rowTexts = () => [...document.querySelectorAll(".thread-card-rows > .thread-card-row")].map((row) => row.textContent);

describe("what a thread's card says", () => {
  it("draws the whole title, then a line per fact the thread has", () => {
    drawCard({ agents: { total: 3, working: 1 }, stat: { added: 12, removed: 3, files: 2, at: 1 } });
    expect(screen.getByText(SESSION.title).tagName).toBe("STRONG");
    expect(rowTexts()).toEqual([
      "Ttau",
      "fix/K59-thread-card",
      "gpt-5.6-luna · Pi via ChatGPT plan",
      "Updated 5m ago",
      "Last turn +12 −3 in 2 files",
      "3 agents, 1 running",
      "$0.42 · Billed via the API",
    ]);
  });

  it("leaves out what the thread does not have", () => {
    const { projectLabel: _branch, usage: _usage, model: _model, modelProvider: _provider, backendKind: _kind, ...bare } = SESSION;
    drawCard({ session: bare, showCost: true });
    // The project's initial is its mark; no branch, no model, no cost.
    expect(rowTexts()).toEqual(["Ttau", "Updated 5m ago"]);
  });

  it("says the thread's state and why, in the state's tone", () => {
    drawCard({ activity: "failed", activityLabel: "Failed", activityHint: "stream disconnected" });
    const status = screen.getByText("Failed: stream disconnected").closest(".thread-card-row")!;
    expect(status.classList.contains("tone-danger")).toBe(true);
    cleanup();
    drawCard({ activity: "working", activityLabel: "Working", agents: { total: 2, working: 2 } });
    expect(rowTexts()).toContain("Working");
    expect(rowTexts()).toContain("2 agents running");
    cleanup();
    drawCard({ activity: "waiting", activityLabel: "Question" });
    expect(rowTexts()).toContain("Question");
    cleanup();
    drawCard({ activity: "waiting" });
    expect(rowTexts()).toContain("Question");
  });

  it("names another machine and why its thread cannot open", () => {
    drawCard({ machine: { name: "rex", icon: <i /> }, unavailable: "rex is offline" });
    expect(rowTexts()).toContain("rex");
    expect(screen.getByText("rex is offline").closest(".thread-card-row")!.classList.contains("tone-warning")).toBe(true);
  });

  it("draws other kits' lines in order among its own, and their sections below a divider", () => {
    const seen: ThreadCardSectionProps[] = [];
    const sections: ThreadCardSection[] = [
      { place: "row", order: 45, Component: ({ Row, ...props }) => { seen.push({ Row, ...props }); return <Row icon={<i />}>2 terminal processes running</Row>; } },
      { place: "row", order: 20, Component: ({ Row, external }) => external ? null : <Row icon={<i />}>Mac mini</Row> },
      { place: "section", order: 10, Component: ({ Row }) => <Row icon={<i />} onClick={() => undefined} label="PR #43">#43 Fix release</Row> },
      { place: "section", order: 20, Component: () => null },
    ];
    const { onClose } = drawCard({ sections });
    expect(rowTexts()).toEqual([
      "Ttau",
      "Mac mini",
      "fix/K59-thread-card",
      "gpt-5.6-luna · Pi via ChatGPT plan",
      "2 terminal processes running",
      "Updated 5m ago",
      "$0.42 · Billed via the API",
    ]);
    expect(seen[0]).toMatchObject({ session: SESSION, external: false, actions });
    const blocks = [...document.querySelectorAll(".thread-card-section")];
    expect(blocks).toHaveLength(2);
    // An empty section is drawn empty, and `:empty` hides it with its divider.
    expect(blocks[1]!.childNodes).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "PR #43" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
