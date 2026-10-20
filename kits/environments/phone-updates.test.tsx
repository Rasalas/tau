// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type UpdateCenterView, type UpdateCoordinator } from "tau";
import { ClientEnvironmentProvider, electronClientEnvironment, HostClientProvider } from "../../src/renderer/test-support/kit-harness.js";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { PhoneUpdates } from "./phone-updates.js";

afterEach(cleanup);

function setup(initial: UpdateCenterView, notice = false) {
  let view = initial;
  const listeners = new Set<() => void>();
  const updates: UpdateCoordinator = {
    getSnapshot: () => view,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    review: vi.fn(async () => {}), run: vi.fn(async () => {}), check: vi.fn(async () => {}),
    retry: vi.fn(async () => {}), cancelQueued: vi.fn(async () => {}),
  };
  const client = createFakeHostClient({ releaseNotes: async () => [
    { version: "0.8.0", items: ["New update review"], totalItems: 1 },
    { version: "0.7.9", items: ["Earlier improvements"], totalItems: 1 },
  ] });
  render(<ClientEnvironmentProvider environment={{ ...electronClientEnvironment(new URLSearchParams()), profile: "compact", mobileApp: { platform: "ios", version: "0.7.8" } }}>
    <HostClientProvider client={client}><PhoneUpdates updates={updates} notice={notice} /></HostClientProvider>
  </ClientEnvironmentProvider>);
  return { updates, set(next: UpdateCenterView) { view = next; act(() => listeners.forEach((listener) => listener())); } };
}

const plan = (): UpdateCenterView => ({ steps: Array.from({ length: 10 }, (_, i) => ({
  machine: `m${i}`, machineName: `Machine ${i}`, kind: "machine", label: `Machine ${i}`, fromVersion: "0.7.8", version: "0.8.0", state: "pending",
})), busy: false, reading: false, started: false });

describe("phone updates", () => {
  it("reviews ten machines, opens several releases by tapping, and returns without installing", async () => {
    const initial = plan();
    initial.steps.push({ machine: "m0", machineName: "Machine 0", kind: "tools", label: "Agent tools", state: "pending" });
    const { updates, set } = setup(initial);
    fireEvent.click(screen.getByRole("button", { name: "Machine updates: 10 machines with updates" }));
    const review = await screen.findByRole("dialog", { name: "Machine updates" });
    expect(within(review).getAllByRole("listitem")).toHaveLength(10);
    expect(within(review).getByText(/App Store or TestFlight/)).toBeTruthy();
    fireEvent.click(within(review).getByRole("button", { name: /What’s new in 0.8.0/ }));
    const notes = await screen.findByRole("dialog", { name: "What’s new" });
    expect(await within(notes).findByText("Earlier improvements")).toBeTruthy();
    expect(within(notes).getByText("New update review")).toBeTruthy();
    set({ ...initial, reading: true, steps: [] });
    expect(screen.getByRole("dialog", { name: "What’s new" })).toBeTruthy();
    set(initial);
    fireEvent.click(within(notes).getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("dialog", { name: "What’s new" })).toBeNull();
    expect(within(review).getByRole("button", { name: "Update all" })).toBeTruthy();
    expect(updates.run).not.toHaveBeenCalled();
  });

  it("uses the shared run and keeps queued updates reachable after hiding progress", async () => {
    const initial = plan();
    const { updates, set } = setup(initial);
    fireEvent.click(screen.getByRole("button", { name: /Machine updates:/ }));
    const review = await screen.findByRole("dialog", { name: "Machine updates" });
    fireEvent.click(await within(review).findByRole("switch", { name: "Resume interrupted threads" }));
    fireEvent.click(within(review).getByRole("button", { name: "Update all" }));
    expect(updates.run).toHaveBeenCalledWith(false);
    set({ ...initial, started: true, steps: initial.steps.map((step, index) => ({ ...step, state: index < 8 ? "done" : "queued", deferUntilOnline: index >= 8 })) });
    fireEvent.click(within(review).getByRole("button", { name: "Cancel update for Machine 9" }));
    expect(updates.cancelQueued).toHaveBeenCalledWith("m9");
    fireEvent.click(within(review).getByRole("button", { name: "Hide progress" }));
    expect(screen.queryByRole("dialog", { name: "Machine updates" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Machine updates: 2 waiting for connection" }));
    expect(await screen.findByRole("button", { name: "Cancel update for Machine 8" })).toBeTruthy();
    expect(updates.run).toHaveBeenCalledTimes(1);
  });

  it("keeps the success page open when the thread-list notice settles", async () => {
    const initial = plan();
    const { set } = setup(initial, true);
    fireEvent.click(screen.getByRole("button", { name: /Machine updates:/ }));
    await screen.findByRole("dialog", { name: "Machine updates" });
    set({ ...initial, started: true, steps: initial.steps.map((step) => ({ ...step, state: "done" })) });
    const review = screen.getByRole("dialog", { name: "Machine updates" });
    expect(within(review).getByText("Updates finished")).toBeTruthy();
    fireEvent.click(within(review).getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("dialog", { name: "Machine updates" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Machine updates:/ })).toBeNull();
  });

  it("reports a skipped tool update on an otherwise updated machine", async () => {
    const initial = plan();
    initial.started = true;
    initial.steps = [{ machine: "m0", machineName: "Machine 0", kind: "tools", label: "Agent tools", state: "skipped", message: "No supported installer" }, { ...initial.steps[0]!, state: "done" }];
    setup(initial);
    fireEvent.click(screen.getByRole("button", { name: "Machine updates: Some updates were skipped" }));
    const review = await screen.findByRole("dialog", { name: "Machine updates" });
    expect(within(review).getByText("Updates finished")).toBeTruthy();
    fireEvent.click(within(review).getByText("Updated", { selector: "summary" }));
    expect(within(review).getByText("Agent tools skipped: No supported installer")).toBeTruthy();
  });

  it("checks explicitly when up to date, and keeps a quiet thread list", async () => {
    const { updates, set } = setup({ steps: [], busy: false, reading: false, started: false });
    fireEvent.click(screen.getByRole("button", { name: "Machine updates: Up to date" }));
    const review = await screen.findByRole("dialog", { name: "Machine updates" });
    fireEvent.click(within(review).getByRole("button", { name: "Check for updates" }));
    expect(updates.review).toHaveBeenCalledOnce();
    set({ steps: [{ machine: "readonly", machineName: "Read only", label: "Read only", kind: "machine", state: "skipped", message: "Full access is required" }], busy: false, reading: false, started: false });
    expect(within(review).getByText("No updates ready")).toBeTruthy();
    expect(within(review).queryByRole("button", { name: "Update all" })).toBeNull();
    cleanup();
    setup({ steps: [], busy: false, reading: false, started: false }, true);
    expect(screen.queryByRole("button", { name: /Machine updates:/ })).toBeNull();
  });
});
