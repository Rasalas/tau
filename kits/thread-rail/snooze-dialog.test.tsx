// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientStorage, UiSession } from "tau";
import { ClientStorageProvider, createMemoryStorage } from "../../src/renderer/test-support/kit-harness.js";
import { readWhenPick, rememberWhenPick } from "tau";
import { SNOOZE_REMEMBER_KEY, SnoozeDialog } from "./organizer.js";

afterEach(cleanup);

// A Wednesday morning: every preset is offered.
const NOW = new Date(2026, 8, 23, 10, 0).getTime();
const thread = (id: string, title = id): UiSession => ({
  id, path: `/sessions/${id}.jsonl`, title, modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 1,
});

function open(sessions: UiSession[], storage: ClientStorage = createMemoryStorage()) {
  const onSnooze = vi.fn();
  const onClose = vi.fn();
  render(
    <ClientStorageProvider storage={storage}>
      <SnoozeDialog sessions={sessions} now={() => NOW} onClose={onClose} onSnooze={onSnooze} />
    </ClientStorageProvider>,
  );
  return { onSnooze, onClose, storage };
}

const picked = async () => (await screen.findByRole("option", { selected: true })).textContent;
const snoozeButton = () => screen.getByRole("button", { name: "Snooze" }) as HTMLButtonElement;

describe("the Snooze dialog", () => {
  it("lists the presets, focuses the list, and opens on the first one when nothing is remembered", async () => {
    open([thread("a", "Fix the queue")]);
    const list = await screen.findByRole("listbox", { name: "Snooze until" });
    expect(screen.getByRole("heading").textContent).toBe("Snooze “Fix the queue”");
    expect(screen.getAllByRole("option").map((option) => option.querySelector("span")?.textContent))
      .toEqual(["In 1 hour", "In 3 hours", "This evening", "Tomorrow", "Monday", "Pick a date and time…"]);
    expect(await picked()).toContain("In 1 hour");
    await waitFor(() => expect(document.activeElement).toBe(list));
  });

  it("names how many threads it snoozes", async () => {
    open([thread("a"), thread("b")]);
    expect((await screen.findByRole("heading")).textContent).toBe("Snooze 2 threads");
  });

  it("opens on the remembered pick, snoozes until its time and remembers the pick used", async () => {
    const storage = createMemoryStorage();
    rememberWhenPick(storage, SNOOZE_REMEMBER_KEY, "tomorrow");
    const { onSnooze } = open([thread("a")], storage);
    expect(await picked()).toContain("Tomorrow");
    const list = screen.getByRole("listbox");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(await picked()).toContain("Monday");
    await waitFor(() => expect(snoozeButton().disabled).toBe(false));
    fireEvent.click(snoozeButton());
    expect(onSnooze).toHaveBeenCalledWith(new Date(2026, 8, 28, 9, 0).getTime());
    expect(readWhenPick(storage, SNOOZE_REMEMBER_KEY)).toBe("next-week");
  });

  it("confirms with Enter on the list", async () => {
    const { onSnooze, storage } = open([thread("a")]);
    const list = await screen.findByRole("listbox");
    fireEvent.keyDown(list, { key: "End" });
    fireEvent.keyDown(list, { key: "ArrowUp" });
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(await picked()).toContain("Tomorrow");
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onSnooze).toHaveBeenCalledWith(new Date(2026, 8, 24, 9, 0).getTime());
    expect(readWhenPick(storage, SNOOZE_REMEMBER_KEY)).toBe("tomorrow");
  });

  it("snoozes until a date of the user's own, and holds Snooze back while that date has passed", async () => {
    const { onSnooze, storage } = open([thread("a")]);
    fireEvent.click(await screen.findByRole("option", { name: /Pick a date and time/u }));
    const field = await screen.findByLabelText("Date and time");
    fireEvent.change(field, { target: { value: "2026-09-20T08:00" } });
    await waitFor(() => expect(snoozeButton().disabled).toBe(true));
    fireEvent.change(field, { target: { value: "2026-10-01T16:30" } });
    await waitFor(() => expect(snoozeButton().disabled).toBe(false));
    fireEvent.click(snoozeButton());
    expect(onSnooze).toHaveBeenCalledWith(new Date(2026, 9, 1, 16, 30).getTime());
    expect(readWhenPick(storage, SNOOZE_REMEMBER_KEY)).toBe("custom");
  });

  it("remembers nothing when cancelled", async () => {
    const { onSnooze, onClose, storage } = open([thread("a")]);
    await screen.findByRole("listbox");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel" })); });
    expect(onClose).toHaveBeenCalled();
    expect(onSnooze).not.toHaveBeenCalled();
    expect(readWhenPick(storage, SNOOZE_REMEMBER_KEY)).toBeUndefined();
  });
});

it("leaves a removed remembered machine option unselected", async () => {
  const storage = createMemoryStorage();
  rememberWhenPick(storage, SNOOZE_REMEMBER_KEY, "removed");
  open([thread("a")], storage);
  await screen.findByRole("listbox");
  expect(screen.queryByRole("option", { selected: true })).toBeNull();
  expect(snoozeButton().disabled).toBe(true);
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
  expect(await picked()).toContain("In 1 hour");
});
