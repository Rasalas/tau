// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiSession, WorkbenchActions } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { createKitHarness, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { ProjectPromotionDialog } from "./project-promotion-dialog.js";
import { projectPromotionMenu, PROMOTE_PROJECT } from "./project-promotion-menu.js";
import { createWorkspaceHostClient } from "./protocol.js";
import type { WorkspaceStore } from "./store.js";
import { workspaceExtension } from "./desktop.js";

afterEach(() => { cleanup(); setHostClient(undefined); });
const session: UiSession = { id: "rex~thread", path: "tau-thread:machine:rex~thread", workspaceId: "ws1_rex_private", projectPath: "/home/rex/private", projectName: "No project", projectless: true, title: "Research notes", modifiedAt: 1, messageCount: 2 };

function fixture(promote?: () => Promise<unknown>, readOnly = false) {
  setHostClient(createFakeHostClient({ isReadOnly: () => readOnly }));
  const invoke = vi.fn(async (command: string, _input: unknown) => {
    if (command === "promotion-info") return { title: session.title, workspace: { workspaceId: session.workspaceId, displayPath: session.projectPath }, otherThreads: 2, promoted: false };
    if (command === "promote-scratch") return promote ? promote() : { workspace: { workspaceId: session.workspaceId, displayPath: session.projectPath }, name: "Research notes" };
    throw new Error(command);
  });
  const host = createWorkspaceHostClient(invoke);
  const close = vi.fn(); const settings = vi.fn(); const toast = vi.fn(); const notify = vi.fn();
  const store = { closeProjectPromotion: close, refresh: vi.fn(async () => undefined), openProjectSettings: settings } as unknown as WorkspaceStore;
  render(<ProjectPromotionDialog session={session} host={host} store={store} actions={{ toast, notify } as unknown as WorkbenchActions} />);
  return { invoke, close, settings, toast };
}

describe("project promotion UI", () => {
  it.each(["desktop", "web", "compact"] as const)("registers its dialog on %s", (profile) => {
    const { registry } = createKitHarness(undefined, profile);
    registry.activate(workspaceExtension);
    expect(registry.getRegions("composer-above").some((region) => region.id === "workspace.project-promotion")).toBe(true);
    registry.deactivate(workspaceExtension.id);
  });

  it("cancels without starting a write and defaults to the thread title without Git", async () => {
    const f = fixture();
    expect((await screen.findByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Research notes");
    expect((screen.getByRole("checkbox", { name: "Start a Git repository" }) as HTMLInputElement).checked).toBe(false);
    await screen.findByText("2 other threads in this folder move with it.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.invoke.mock.calls.some(([command]) => command === "promote-scratch")).toBe(false);
  });

  it("uses the home workspace and thread identities, leaves the active thread alone and offers settings", async () => {
    const f = fixture();
    const submit = await screen.findByRole("button", { name: "Turn into project" });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(f.invoke).toHaveBeenCalledWith("promote-scratch", { workspace: "ws1_rex_private", sessionId: "rex~thread", name: "Research notes", git: false }));
    await waitFor(() => expect(f.toast).toHaveBeenCalled());
    expect(f.toast.mock.calls[0]![0].title).toBe('"Research notes" is now a project.');
    f.toast.mock.calls[0]![0].actions[0].run();
    expect(f.settings).toHaveBeenCalledWith({ projectPath: session.projectPath, projectName: "Research notes", workspaceId: session.workspaceId });
  });

  it("retains the dialog and values after a host failure and permits retry", async () => {
    const promote = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce({ workspace: { workspaceId: session.workspaceId, displayPath: session.projectPath }, name: "Notes" });
    const f = fixture(promote);
    const name = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Notes" } });
    const submit = screen.getByRole("button", { name: "Turn into project" });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(submit);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "disk full");
    expect((name as HTMLInputElement).value).toBe("Notes");
    expect(f.close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Turn into project" }));
    await waitFor(() => expect(f.close).toHaveBeenCalledOnce());
  });

  it("prevents duplicate submission and keeps a committed request open until it finishes", async () => {
    let finish!: (value: unknown) => void;
    const f = fixture(() => new Promise((resolve) => { finish = resolve; }));
    const submit = screen.getByRole("button", { name: "Turn into project" });
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(submit); fireEvent.click(submit);
    expect(f.invoke.mock.calls.filter(([command]) => command === "promote-scratch")).toHaveLength(1);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish({ workspace: { workspaceId: session.workspaceId, displayPath: session.projectPath }, name: "Research notes" }));
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("disables writing for a Read-only device", async () => {
    const f = fixture(undefined, true);
    await screen.findByText("2 other threads in this folder move with it.");
    const submit = screen.getByRole("button", { name: "Turn into project" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.title).toBe("Read only: this needs a device with Full access.");
    expect(f.invoke.mock.calls.some(([command]) => command === "promote-scratch")).toBe(false);
  });

  it("places the action immediately above settings, only for projectless threads", () => {
    const sections = [{ items: [{ id: "project-settings", label: "Project settings…" }] }];
    const menu = projectPromotionMenu(sections, session, false);
    expect(menu[0]!.items.map((item) => item.id)).toEqual([PROMOTE_PROJECT, "project-settings"]);
    expect(sections[0]!.items).toHaveLength(1);
    expect(projectPromotionMenu(sections, { ...session, projectless: false }, false)[0]!.items).toHaveLength(1);
    expect(projectPromotionMenu(sections, session, true)[0]!.items[0]).toMatchObject({ disabled: true, description: "Read only: this needs a device with Full access." });
  });
});
