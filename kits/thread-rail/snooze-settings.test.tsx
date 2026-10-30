// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HostClientProvider } from "../../src/renderer/test-support/kit-harness.js";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { createSnoozeRows } from "./snooze-settings.js";
import { RailStore } from "./store.js";
import { DEFAULT_SETTINGS, DEFAULT_SNOOZE_PRESETS } from "./meta.js";
import type { RailSettings } from "./protocol.js";
afterEach(cleanup);
function setup(readOnly = false) {
  const store = new RailStore(); store.set({ threads: {}, settings: DEFAULT_SETTINGS });
  const update = vi.fn(async (patch: Partial<RailSettings>) => { store.set({ ...store.getState(), settings: { ...store.getState().settings, ...patch } }); });
  const Rows = createSnoozeRows(store, update);
  render(<HostClientProvider client={createFakeHostClient({ isReadOnly: () => readOnly })}><Rows onNotify={vi.fn()} onChanged={() => undefined} /></HostClientProvider>);
  return { store, update };
}
it("saves valid durations on blur, enforces bounds and resets machine options", async () => {
  const { update, store } = setup();
  const first = within(screen.getByRole("group", { name: "Snooze option 1" }));
  const duration = first.getByRole("spinbutton");
  fireEvent.change(duration, { target: { value: "721" } }); fireEvent.blur(duration);
  expect(screen.getByRole("alert").textContent).toContain("720 hours"); expect(update).not.toHaveBeenCalled();
  fireEvent.change(duration, { target: { value: "2" } }); fireEvent.keyDown(duration, { key: "Enter" });
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(store.getState().settings.snoozePresets?.[0]).toMatchObject({ id: "1h", amount: 2 });
  fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
  await waitFor(() => expect(store.getState().settings.snoozePresets).toEqual(DEFAULT_SNOOZE_PRESETS));
});
it("keeps one to eight options and reflects a host update from another client", async () => {
  const { store } = setup();
  for (let index = 5; index < 8; index++) { fireEvent.click(screen.getByRole("button", { name: "Add option" })); await waitFor(() => expect(screen.getAllByRole("group")).toHaveLength(index + 1)); }
  expect((screen.getByRole("button", { name: "Add option" }) as HTMLButtonElement).disabled).toBe(true);
  act(() => store.set({ threads: {}, settings: { ...DEFAULT_SETTINGS, snoozePresets: [{ id: "tea", kind: "at", day: "today", time: "16:00" }] } }));
  await waitFor(() => expect(screen.getAllByRole("group")).toHaveLength(1));
  expect((screen.getByRole("button", { name: "Remove snooze option 1" }) as HTMLButtonElement).disabled).toBe(true);
});
it("shows a preview but disables every write on a Read-only device", () => {
  const { update } = setup(true);
  expect(screen.getByText(/Right now the menu shows:/u)).toBeTruthy();
  for (const control of document.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>("input, select, button")) expect(control.disabled).toBe(true);
  expect(update).not.toHaveBeenCalled();
});
