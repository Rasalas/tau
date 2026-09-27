// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiSession } from "tau";
import { createArchivedPage, relativeTime } from "./archived-page.js";
import { RailStore } from "./store.js";
import type { TrashedThread } from "./protocol.js";

const threads: UiSession[] = [];
const snapshot = { threads };
vi.mock("tau", async (original) => ({
  ...await original<typeof import("tau")>(),
  useThreadStore: () => ({ subscribe: () => () => undefined, getSnapshot: () => snapshot }),
}));

afterEach(() => { cleanup(); threads.splice(0); });

const NOW = 10 * 24 * 60 * 60_000;
const thread = (id: string, projectName: string): UiSession => ({
  id, path: `/sessions/${id}.jsonl`, title: `Thread ${id}`, modifiedAt: NOW - 60 * 60_000, projectPath: `/${projectName}`, projectName, messageCount: 1,
});

function setup(trash: TrashedThread[] = []) {
  const store = new RailStore();
  const page = {
    unarchive: vi.fn(),
    remove: vi.fn(async () => undefined),
    restore: vi.fn(async () => undefined),
    purge: vi.fn(async () => undefined),
    trash: vi.fn(async () => trash),
    subscribeTrash: vi.fn(() => () => undefined),
  };
  const Page = createArchivedPage(store, page, () => NOW);
  return { store, page, Page };
}

describe("Settings → Archived", () => {
  it("says so when nothing is archived", async () => {
    const { Page } = setup();
    render(<Page onNotify={() => undefined} />);
    expect(screen.getByText("No archived threads")).toBeTruthy();
    expect(screen.getByText(/Archive a thread from its menu in the rail/u)).toBeTruthy();
  });

  it("lists archived threads by project, newest first, and unarchives from the row", async () => {
    threads.push(thread("a", "alpha"), thread("b", "alpha"), thread("c", "beta"), thread("live", "alpha"));
    const { store, page, Page } = setup();
    store.set({ threads: { a: { archivedAt: NOW - 60_000 }, b: { archivedAt: NOW - 1_000 }, c: { archivedAt: NOW - 2 * 24 * 60 * 60_000 } } });
    render(<Page onNotify={() => undefined} />);

    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["alpha", "beta"]);
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Archived", "Thread b", "Thread a", "Thread c"]);
    expect(screen.getByText("Archived 2 days ago · Last active 1 hour ago")).toBeTruthy();
    expect(screen.queryByText("Thread live")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Unarchive Thread b" }));
    expect(page.unarchive).toHaveBeenCalledWith("b");
    fireEvent.contextMenu(screen.getByText("Thread c"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(page.remove).toHaveBeenCalledWith(expect.objectContaining({ id: "c" }));
  });

  it("restores a deleted thread, and deletes it for good only once asked", async () => {
    const { page, Page } = setup([{ sessionId: "gone", cwd: "/alpha", title: "Gone thread", backendKind: "pi", deletedAt: NOW - 5 * 60_000, purgeAt: NOW + 30 * 24 * 60 * 60_000 }]);
    render(<Page onNotify={() => undefined} />);
    await waitFor(() => expect(screen.getByText("Gone thread")).toBeTruthy());
    expect(screen.getByText("Deleted 5 minutes ago · removed for good in 30 days")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Restore Gone thread" }));
    expect(page.restore).toHaveBeenCalledWith("gone");
    fireEvent.click(screen.getByRole("button", { name: "Delete Gone thread now" }));
    expect(page.purge).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Delete “Gone thread” for good?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete Gone thread now" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete for good" }));
    expect(page.purge).toHaveBeenCalledWith("gone");
  });

  it("says when the deleted threads did not load, and asks again", async () => {
    const { page, Page } = setup();
    page.trash.mockRejectedValueOnce(new Error("The host did not answer."));
    render(<Page onNotify={() => undefined} />);
    expect((await screen.findByRole("alert")).textContent).toContain("The host did not answer.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(page.trash).toHaveBeenCalledTimes(2);
  });

  it("speaks of time roughly", () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe("just now");
    expect(relativeTime(NOW - 60_000, NOW)).toBe("1 minute ago");
    expect(relativeTime(NOW + 3 * 60 * 60_000, NOW)).toBe("in 3 hours");
  });
});
