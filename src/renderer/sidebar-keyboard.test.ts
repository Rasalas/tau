// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { installSidebarKeyboard } from "./sidebar-keyboard";
import { ExtensionRegistry, type WorkbenchActions } from "./extension-system";

afterEach(() => { document.body.replaceChildren(); delete document.body.dataset.profile; });
const press = (target: HTMLElement, key: string, extra: KeyboardEventInit = {}) => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));

it("renames the focused thread and opens its menu or Stage without clicking or selecting it", async () => {
  const registry = new ExtensionRegistry();
  const rename = vi.fn();
  await registry.activate({ id: "test", name: "Test", activate(context) { context.registerCommand({ id: "runtime.rename-thread", label: "Rename", group: "Thread", access: "write", run: rename }); } });
  document.body.innerHTML = '<nav class="session-list" aria-label="Threads"><button data-rail-heading="active" aria-expanded="true">Active</button><div data-rail-thread="a"><button class="thread-main">A</button></div><div data-rail-thread="b"><button class="thread-main">B</button></div></nav>';
  const row = document.querySelectorAll<HTMLButtonElement>(".thread-main")[1]!;
  const opened = vi.fn(); const clicked = vi.fn(); const menu = vi.fn();
  row.addEventListener("click", clicked); row.addEventListener("contextmenu", menu);
  const actions = { openThread: opened } as unknown as WorkbenchActions;
  const stop = installSidebarKeyboard(registry, actions, vi.fn());
  try {
    row.focus();
    const details = document.body.appendChild(document.createElement("div"));
    details.className = "thread-card"; details.setAttribute("role", "dialog");
    press(row, "F2"); expect(rename).toHaveBeenCalledWith(actions, { threadId: "b" });
    press(row, "F10", { shiftKey: true }); expect(menu).toHaveBeenCalledOnce();
    press(row, "ContextMenu"); expect(menu).toHaveBeenCalledTimes(2);
    press(row, "Enter", { metaKey: true }); expect(opened).toHaveBeenLastCalledWith("b");
    press(row, "Enter", { ctrlKey: true }); expect(opened).toHaveBeenCalledTimes(2);
    expect(clicked).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(row);
  } finally { stop(); }
});

it("leaves all cursor movement and ordinary activation to the rail model, with no frame-delayed DOM cursor", async () => {
  document.body.innerHTML = '<nav class="session-list" aria-label="Threads"><button data-rail-heading="active" aria-expanded="true">Active</button><div data-rail-thread="a"><button class="thread-main">A</button></div></nav>';
  const row = document.querySelector<HTMLButtonElement>(".thread-main")!;
  const heading = document.querySelector<HTMLButtonElement>("[data-rail-heading]")!;
  const frame = vi.spyOn(window, "requestAnimationFrame");
  const clicked = vi.fn(); row.addEventListener("click", clicked); heading.addEventListener("click", clicked);
  const stop = installSidebarKeyboard(new ExtensionRegistry(), {} as WorkbenchActions, vi.fn());
  try {
    row.focus();
    for (const key of ["Home", "End", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", " "]) expect(press(row, key)).toBe(true);
    for (const key of ["ArrowLeft", "ArrowRight"]) expect(press(heading, key)).toBe(true);
    expect(document.activeElement).toBe(row);
    expect(frame).not.toHaveBeenCalled();
    expect(clicked).not.toHaveBeenCalled();
  } finally { stop(); frame.mockRestore(); }
});

it("yields to row actions, editable fields, headings, pagination, external rows, dialogs and Compact", () => {
  document.body.innerHTML = '<nav class="session-list" aria-label="Threads"><button data-rail-heading="active">Active</button><div data-rail-thread="a"><button class="thread-main">A</button><span class="thread-row-actions"><button id="action">Settle</button></span><input></div><button class="thread-main" id="more">Show more</button><div data-rail-external="remote"><button class="thread-main" id="remote">Remote</button></div></nav>';
  const opened = vi.fn();
  const stop = installSidebarKeyboard(new ExtensionRegistry(), { openThread: opened } as unknown as WorkbenchActions, vi.fn());
  try {
    for (const selector of ["#action", "input", "[data-rail-heading]", "#more", "#remote"]) {
      const element = document.querySelector<HTMLElement>(selector)!;
      for (const key of ["F2", "ContextMenu", "F10"]) expect(press(element, key, { shiftKey: true })).toBe(true);
      expect(press(element, "Enter", { metaKey: true })).toBe(true);
    }
    const row = document.querySelector<HTMLElement>('[data-rail-thread] .thread-main')!;
    const dialog = document.body.appendChild(document.createElement("div")); dialog.setAttribute("role", "dialog");
    expect(press(row, "F2")).toBe(true);
    dialog.remove(); document.body.dataset.profile = "compact";
    expect(press(row, "Enter", { metaKey: true })).toBe(true);
    delete document.body.dataset.profile;
    expect(press(row, "F2", { isComposing: true })).toBe(true);
    expect(opened).not.toHaveBeenCalled();
  } finally { stop(); }
  expect(press(document.querySelector<HTMLElement>(".thread-main")!, "F2")).toBe(true);
});
