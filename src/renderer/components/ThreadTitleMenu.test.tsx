// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openTitleRename, titleRenameRefusal } from "../thread-rename";
import { coreThreadMenu, ThreadTitleMenu, type ThreadTitleMenuModel } from "./ThreadTitleMenu";

afterEach(cleanup);

function fallback(overrides: Partial<Parameters<typeof coreThreadMenu>[0]> = {}) {
  return coreThreadMenu({
    label: "main",
    pinned: false,
    settled: false,
    readOnly: false,
    commands: [{ id: "thread-titles.regenerate", label: "Regenerate title" }],
    canCopyPath: true,
    run: vi.fn(),
    ...overrides,
  });
}

const labels = (model: ThreadTitleMenuModel) => model.sections.map((section) => section.items.map((item) => item.label));

describe("ThreadTitleMenu", () => {
  it("opens the menu it is handed, read when it opens, and runs the pick", () => {
    const run = vi.fn();
    const menu = vi.fn((): ThreadTitleMenuModel => ({ sections: [{ items: [{ id: "pin", label: "Pin thread" }] }, { items: [{ id: "delete", label: "Delete", destructive: true }] }], run }));
    render(<ThreadTitleMenu title="Improve title menu" menu={menu} onRename={vi.fn(async () => true)} />);
    expect(menu).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Improve title menu" }));
    expect(menu).toHaveBeenCalledOnce();
    const last = screen.getAllByRole("menuitem").at(-1)!;
    expect(last.className).toContain("destructive");
    fireEvent.click(screen.getByText("Pin thread"));
    expect(run).toHaveBeenCalledWith("pin");
  });

  it("renames inline for any menu's rename, without running it", async () => {
    const run = vi.fn();
    const onRename = vi.fn(async () => true);
    render(<ThreadTitleMenu title="Improve title menu" menu={() => ({ sections: [{ items: [{ id: "rename", label: "Rename thread" }] }], run })} onRename={onRename} />);

    fireEvent.click(screen.getByRole("button", { name: "Improve title menu" }));
    fireEvent.click(screen.getByText("Rename thread"));
    const input = screen.getByRole("textbox", { name: "Thread title" });
    fireEvent.change(input, { target: { value: "A precise manual title" } });
    fireEvent.submit(input.closest("form")!);

    await waitFor(() => expect(onRename).toHaveBeenCalledWith("A precise manual title"));
    expect(run).not.toHaveBeenCalled();
  });
});

describe("ThreadTitleMenu rename field", () => {
  const mount = (onRename = vi.fn(async (_title: string) => true)) => {
    render(<ThreadTitleMenu title="Improve title menu" menu={() => ({ sections: [], run: vi.fn() })} onRename={onRename} />);
    return onRename;
  };
  const field = () => screen.findByRole("textbox", { name: "Thread title" }) as Promise<HTMLInputElement>;

  it("opens on the Rename command with the whole title selected, and Enter saves the trimmed title", async () => {
    const onRename = mount();
    expect(titleRenameRefusal()).toBeUndefined();
    act(() => openTitleRename());
    const input = await field();
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "Improve title menu".length]);
    fireEvent.change(input, { target: { value: "  Sharper title  " } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(onRename).toHaveBeenCalledWith("Sharper title"));
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(onRename).toHaveBeenCalledOnce();
  });

  it("saves on blur once", async () => {
    const onRename = mount();
    act(() => openTitleRename());
    const input = await field();
    fireEvent.change(input, { target: { value: "Saved by blur" } });
    fireEvent.blur(input);
    fireEvent.blur(input);
    await waitFor(() => expect(onRename).toHaveBeenCalledWith("Saved by blur"));
    expect(onRename).toHaveBeenCalledOnce();
  });

  it("calls nothing on Esc, an empty title or an unchanged one", async () => {
    const onRename = mount();
    act(() => openTitleRename());
    let input = await field();
    fireEvent.change(input, { target: { value: "Typed then dropped" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(screen.getByRole("button", { name: "Improve title menu" })).toBeTruthy();

    act(() => openTitleRename());
    input = await field();
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());

    act(() => openTitleRename());
    input = await field();
    fireEvent.blur(input);
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(onRename).not.toHaveBeenCalled();
  });

  it("stays open when the save fails", async () => {
    const onRename = mount(vi.fn(async () => false));
    act(() => openTitleRename());
    const input = await field();
    fireEvent.change(input, { target: { value: "Refused" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(onRename).toHaveBeenCalledWith("Refused"));
    await waitFor(() => expect(input.readOnly).toBe(false));
    expect(screen.getByRole("textbox", { name: "Thread title" })).toBeTruthy();
  });

  it("is unavailable with no title on screen", () => {
    mount();
    expect(titleRenameRefusal()).toBeUndefined();
    cleanup();
    expect(titleRenameRefusal()).toBe("Open a thread to rename it.");
  });
});

describe("coreThreadMenu", () => {
  it("groups core's thread actions and the title's commands", () => {
    expect(labels(fallback())).toEqual([
      ["New thread on main", "Thread tree…", "Active instructions & prompt…", "Duplicate thread", "Pin thread", "Settle thread"],
      ["Rename thread", "Regenerate title", "Mark unread"],
      ["Copy entire chat as Markdown", "Copy path", "Copy thread ID"],
    ]);
    expect(labels(fallback({ pinned: true, settled: true, canCopyPath: false }))[0]).toContain("Unpin thread");
    expect(labels(fallback({ canCopyPath: false }))[2]).toEqual(["Copy entire chat as Markdown", "Copy thread ID"]);
  });

  it("puts a destructive command last and names commands by id", () => {
    const model = fallback({ commands: [{ id: "thread.delete", label: "Delete", destructive: true }, { id: "thread.archive", label: "Archive thread" }] });
    const last = model.sections.at(-1)!.items;
    expect(last).toEqual([{ id: "command:thread.delete", label: "Delete", destructive: true }]);
    expect(model.sections[1]!.items.map((item) => item.id)).toEqual(["rename", "command:thread.archive", "unread"]);
  });

  it("disables what writes on a Read-only device, and a command that cannot run", () => {
    const model = fallback({ readOnly: true, commands: [{ id: "look", label: "Look", access: "read" }, { id: "gone", label: "Gone", access: "read", unavailable: () => "Not here." }] });
    const byId = new Map(model.sections.flatMap((section) => section.items).map((item) => [item.id, item]));
    expect(byId.get("pin")?.disabled).toBe(true);
    expect(byId.get("tree")?.disabled).toBeUndefined();
    expect(byId.get("command:look")?.disabled).toBeUndefined();
    expect(byId.get("command:gone")).toMatchObject({ disabled: true, description: "Not here." });
  });
});
