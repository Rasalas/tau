// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { WORKSPACE_STORE_SERVICE } from "../workspace/protocol.js";
import { startCustomization } from "./customize-entry.js";
import { packagesExtension } from "./desktop.js";
import { CUSTOMIZE_PROMPT_PREFIX, PACKAGES_EXTENSION_ID } from "./protocol.js";

afterEach(cleanup);

const DIRECTORY = "/home/.tau/extensions";
const PROJECT = { directory: DIRECTORY, workspaceId: "ws1_customizations" };

/** A window whose draft opens in the project it is told to, with a composer that remembers its text. */
function windowActions(initialDraft = "") {
  let draft = initialDraft;
  let thread: { sessionId?: string; draftPending: boolean; workspaceId: string; cwd: string } | undefined;
  const app = {
    notify: vi.fn(),
    closeSettings: vi.fn(),
    focusComposer: vi.fn(),
    openWorkspace: vi.fn(async () => true),
    newSession: vi.fn((options?: { workspace?: string }) => { thread = { draftPending: false, workspaceId: options?.workspace ?? "", cwd: DIRECTORY }; }),
    activeThread: () => thread,
    composerDraft: () => draft,
    setComposerDraft: vi.fn((text: string) => { draft = text; }),
    sendPrompt: vi.fn(),
  };
  return { app, actions: app as unknown as WorkbenchActions, draft: () => draft };
}

const host = (invoke = vi.fn(async (command: string): Promise<unknown> => command === "customization-project" ? PROJECT : { directory: DIRECTORY, packages: 0 })) => ({ invoke, onEvent: () => () => undefined });

describe("Customize Tau…", () => {
  it("opens a draft in the customization project with the prompt's start, and sends nothing", async () => {
    const { app, actions, draft } = windowActions();
    const client = host();
    const onFolder = vi.fn();
    await startCustomization(client, actions, onFolder);
    expect(client.invoke).toHaveBeenCalledWith("customization-project");
    expect(onFolder).toHaveBeenCalledWith(DIRECTORY);
    expect(app.openWorkspace).toHaveBeenCalledWith("ws1_customizations");
    expect(app.newSession).toHaveBeenCalledWith({ workspace: "ws1_customizations" });
    expect(draft()).toBe(CUSTOMIZE_PROMPT_PREFIX);
    expect(CUSTOMIZE_PROMPT_PREFIX).toBe("Change Tau: ");
    expect(app.focusComposer).toHaveBeenCalled();
    expect(app.sendPrompt).not.toHaveBeenCalled();
  });

  it("takes the same project the second time", async () => {
    const first = windowActions();
    const second = windowActions();
    const client = host();
    await startCustomization(client, first.actions);
    await startCustomization(client, second.actions);
    expect(second.app.openWorkspace).toHaveBeenCalledWith("ws1_customizations");
    expect(second.app.newSession).toHaveBeenCalledWith({ workspace: "ws1_customizations" });
    expect(second.draft()).toBe(CUSTOMIZE_PROMPT_PREFIX);
  });

  it("asks again while the window does not list the project yet", async () => {
    const { app, actions, draft } = windowActions();
    const open = app.newSession.getMockImplementation()!;
    app.newSession.mockImplementationOnce(() => undefined).mockImplementationOnce(() => undefined).mockImplementation(open);
    await startCustomization(host(), actions);
    expect(app.newSession.mock.calls.length).toBeGreaterThan(1);
    expect(draft()).toBe(CUSTOMIZE_PROMPT_PREFIX);
  });

  it("uses a draft of the project that is already on screen instead of making another", async () => {
    const { app, actions, draft } = windowActions();
    await startCustomization(host(), actions);
    expect(app.newSession).toHaveBeenCalledTimes(1);
    await startCustomization(host(), actions);
    expect(app.newSession).toHaveBeenCalledTimes(1);
    expect(draft()).toBe(CUSTOMIZE_PROMPT_PREFIX);
  });

  it("writes through the window's current actions once the new draft has them", async () => {
    const stale = windowActions();
    const fresh = windowActions();
    fresh.app.activeThread = stale.app.activeThread;
    let current = stale.actions;
    stale.app.newSession.mockImplementationOnce((options?: { workspace?: string }) => { stale.app.activeThread = () => ({ draftPending: false, workspaceId: options?.workspace ?? "", cwd: DIRECTORY }) as never; setTimeout(() => { current = fresh.actions; }, 40); });
    await startCustomization(host(), stale.actions, undefined, () => current);
    expect(fresh.draft()).toBe(CUSTOMIZE_PROMPT_PREFIX);
    expect(stale.draft()).toBe("");
  });

  it("keeps what the user already typed in the draft", async () => {
    const { actions, draft } = windowActions("make the sidebar wider");
    await startCustomization(host(), actions);
    expect(draft()).toBe("make the sidebar wider");
  });

  it("says why when the project cannot be made, and opens no draft", async () => {
    const { app, actions } = windowActions();
    await startCustomization(host(vi.fn(async () => { throw new Error("EACCES: permission denied"); })), actions);
    expect(app.notify).toHaveBeenCalledWith("EACCES: permission denied", "error");
    expect(app.newSession).not.toHaveBeenCalled();
  });

  it("is a palette command, and tells the no-worktree rule about the folder", async () => {
    const invoke = vi.fn(async (_id: string, command: string): Promise<unknown> => command === "customization-project" ? PROJECT : { directory: DIRECTORY, packages: 0 });
    const { registry } = createKitHarness(invoke);
    const registered: Array<(cwd: string) => boolean> = [];
    registry.activate({
      id: "test.workspace",
      name: "Workspace",
      activate: (context) => { context.provideService(WORKSPACE_STORE_SERVICE, { registerInPlaceProjects: (match: (cwd: string) => boolean) => { registered.push(match); return () => undefined; } }); },
    });
    registry.activate(packagesExtension);
    const command = registry.getCommands().find((entry) => entry.id === "packages.customize");
    expect(command?.label).toBe("Customize Tau…");

    const { app, actions, draft } = windowActions();
    await command?.run(actions);
    expect(invoke).toHaveBeenCalledWith(PACKAGES_EXTENSION_ID, "customization-project", undefined);
    expect(draft()).toBe(CUSTOMIZE_PROMPT_PREFIX);
    expect(app.newSession).toHaveBeenCalledTimes(1);
    expect(registered).toHaveLength(1);
    expect(registered[0]!(DIRECTORY)).toBe(true);
    expect(registered[0]!(`${DIRECTORY}/`)).toBe(true);
    expect(registered[0]!("/home/dev/project")).toBe(false);
  });

  it("is a button at the top of Settings → Extensions, with a sentence while nothing is installed", async () => {
    const invoke = vi.fn(async (_id: string, command: string): Promise<unknown> => command === "customization-project" ? PROJECT : command === "list" ? { packages: [] } : { directory: DIRECTORY, packages: 0 });
    const { registry } = createKitHarness(invoke);
    registry.activate(packagesExtension);
    const { app, actions, draft } = windowActions();
    const bind = registry.getRegions("composer-above").find((region) => region.id === "packages.customize-actions")!;
    const section = registry.getSettingsSections("extensions").find((entry) => entry.id === "packages.customize")!;
    render(<><bind.Component actions={actions} snapshot={undefined as never} /><section.Component onNotify={vi.fn()} onChanged={vi.fn()} /></>);

    expect(await screen.findByText(/Nothing is installed yet/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Customize Tau…" }));
    await waitFor(() => expect(draft()).toBe(CUSTOMIZE_PROMPT_PREFIX));
    expect(app.closeSettings).toHaveBeenCalled();
    expect(app.sendPrompt).not.toHaveBeenCalled();
  });

  it("drops the sentence once something is installed", async () => {
    const invoke = vi.fn(async (_id: string, command: string): Promise<unknown> => command === "list" ? { packages: [] } : { directory: DIRECTORY, packages: 2 });
    const { registry } = createKitHarness(invoke);
    registry.activate(packagesExtension);
    const section = registry.getSettingsSections("extensions").find((entry) => entry.id === "packages.customize")!;
    render(<section.Component onNotify={vi.fn()} onChanged={vi.fn()} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(PACKAGES_EXTENSION_ID, "list", undefined));
    // Both answers in, and the section has drawn them.
    await act(async () => { await Promise.all(invoke.mock.results.map((result) => result.value)); });
    expect(screen.getByRole("button", { name: "Customize Tau…" })).toBeTruthy();
    expect(screen.queryByText(/Nothing is installed yet/u)).toBeNull();
  });
});
