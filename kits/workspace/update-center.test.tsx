// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { workspaceExtension } from "./desktop.js";
import { UPDATE_CENTER_SERVICE, type DesktopExtension, type UpdateCenterView, type UpdateCoordinator } from "tau";

afterEach(() => { cleanup(); setHostClient(undefined); });
const notes = [{ version: "0.8.0", items: ["A real change from the fixture"], totalItems: 1, url: "https://github.com/o/r/releases/tag/v0.8.0" }, { version: "0.7.9", items: ["Changes from the preceding release"], totalItems: 1 }];

describe("the shared update entry", () => {
  it("reviews changes before installing and keeps a readable changelog in the same menu", async () => {
    const client = createFakeHostClient({ invokeHostExtension: workspaceHostStub(), windowAction: async (action) => action.kind === "release-notes" ? notes : undefined });
    const install = vi.fn();
    renderApp(client, { extensions: [workspaceExtension], seed: (services) => services.appUpdate?.set({ version: "0.8.0", install }) });
    fireEvent.click(await screen.findByRole("button", { name: "Tau 0.8.0 is ready: restart to update" }));
    const menu = await screen.findByRole("dialog", { name: "Updates" });
    expect(install).not.toHaveBeenCalled();
    fireEvent.click(await within(menu).findByRole("button", { name: /What's new in/ }));
    expect(await within(menu).findByText(notes[0]!.items[0]!)).toBeTruthy();
    fireEvent.click(within(menu).getByRole("button", { name: "Back to updates" }));
    fireEvent.click(within(menu).getByRole("button", { name: "Update" }));
    expect(install).toHaveBeenCalledOnce();
  });
  it("previews notes on hover without starting an update", async () => {
    const client = createFakeHostClient({ invokeHostExtension: workspaceHostStub(), windowAction: async (action) => action.kind === "release-notes" ? notes : undefined });
    const install = vi.fn();
    renderApp(client, { extensions: [workspaceExtension], seed: (services) => services.appUpdate?.set({ version: "0.8.0", install }) });
    fireEvent.pointerEnter(await screen.findByRole("button", { name: "Tau 0.8.0 is ready: restart to update" }), { pointerType: "mouse" });
    const preview = await screen.findByRole("dialog", { name: "Update preview" });
    expect(await within(preview).findByText(notes[0]!.items[0]!)).toBeTruthy();
    expect(install).not.toHaveBeenCalled();
  });
  it("keeps every release reachable while the mouse crosses into the hover card", async () => {
    const client = createFakeHostClient({ invokeHostExtension: workspaceHostStub(), windowAction: async (action) => action.kind === "release-notes" ? notes : undefined });
    const install = vi.fn();
    renderApp(client, { extensions: [workspaceExtension], seed: (services) => services.appUpdate?.set({ version: "0.8.0", install }) });
    const trigger = await screen.findByRole("button", { name: "Tau 0.8.0 is ready: restart to update" });
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    const preview = await screen.findByRole("dialog", { name: "Update preview" });
    expect(await within(preview).findByRole("heading", { name: "0.7.9" })).toBeTruthy();
    fireEvent.pointerLeave(trigger);
    fireEvent.pointerEnter(preview.querySelector(".update-preview-content")!);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.getByRole("dialog", { name: "Update preview" })).toBe(preview);
    fireEvent.click(within(preview).getByRole("button", { name: "Review updates" }));
    expect(await screen.findByRole("dialog", { name: "Updates" })).toBeTruthy();
    expect(install).not.toHaveBeenCalled();
  });
  it("groups ten machines and sends the continuation choice to the shared coordinator", async () => {
    const view: UpdateCenterView = { steps: Array.from({ length: 10 }, (_, i) => ({ machine: `m${i}`, machineName: `Machine ${i}`, kind: i === 9 ? "app" : "machine", label: `Machine ${i}`, version: "0.8.0", state: i < 4 ? "done" : "pending" })), busy: false, reading: false, started: false };
    const run = vi.fn(async () => {});
    const updates: UpdateCoordinator = { getSnapshot: () => view, subscribe: () => () => {}, review: vi.fn(), check: vi.fn(), run };
    const provider: DesktopExtension = { id: "updates-test", name: "Updates", activate: (context) => { context.provideService(UPDATE_CENTER_SERVICE, updates); } };
    renderApp(undefined, { extensions: [workspaceExtension, provider] });
    fireEvent.click(await screen.findByRole("button", { name: "Tau 0.8.0 is ready: restart to update" }));
    const menu = await screen.findByRole("dialog", { name: "Updates" });
    expect(within(menu).queryByText("Machine 0")).toBeNull();
    fireEvent.click(within(menu).getByRole("button", { name: /Updated/ }));
    expect(within(menu).getByText("Machine 0")).toBeTruthy();
    fireEvent.click(within(menu).getByRole("checkbox", { name: "Resume interrupted threads" }));
    fireEvent.click(within(menu).getByRole("button", { name: "Update all" }));
    expect(run).toHaveBeenCalledExactlyOnceWith(false);
  });
  it("keeps queued work visible and lets the user cancel it", async () => {
    let view: UpdateCenterView = { busy: false, reading: false, started: true, steps: [{ machine: "rex", machineName: "rex", kind: "machine", label: "rex", state: "queued", deferUntilOnline: true, message: "Updates when connected" }] };
    const listeners = new Set<() => void>();
    const cancelQueued = vi.fn(async () => { view = { ...view, steps: [] }; for (const listener of listeners) listener(); });
    const updates: UpdateCoordinator = { getSnapshot: () => view, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, review: vi.fn(), check: vi.fn(), run: vi.fn(), cancelQueued };
    const provider: DesktopExtension = { id: "queued-updates-test", name: "Updates", activate: (context) => { context.provideService(UPDATE_CENTER_SERVICE, updates); } };
    renderApp(undefined, { extensions: [workspaceExtension, provider] });
    fireEvent.click(await screen.findByRole("button", { name: "1 machine will update when online" }));
    const menu = await screen.findByRole("dialog", { name: "Updates" });
    expect(within(menu).getByText("Waiting for machines")).toBeTruthy();
    expect(within(menu).queryByRole("button", { name: "Done" })).toBeNull();
    fireEvent.click(within(menu).getByRole("button", { name: "Cancel queued update for rex" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Updates" })).toBeNull());
    expect(cancelQueued).toHaveBeenCalledExactlyOnceWith("rex");
  });
});
