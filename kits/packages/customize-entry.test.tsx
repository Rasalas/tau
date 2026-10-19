// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import { createKitHarness, ThreadStore, ThreadStoreContext } from "../../src/renderer/test-support/kit-harness.js";
import { WORKSPACE_STORE_SERVICE } from "../workspace/protocol.js";
import { createPendingPrefix, startCustomization } from "./customize-entry.js";
import { packagesExtension } from "./desktop.js";
import { CUSTOMIZE_PROMPT_PREFIX, PACKAGES_EXTENSION_ID } from "./protocol.js";

afterEach(cleanup);

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const DIRECTORY = "/home/.tau/extensions";
const PROJECT = { directory: DIRECTORY, workspaceId: "ws1_customizations" };

type Thread = { sessionId?: string; draftPending: boolean; workspaceId: string; cwd: string };

const session = (id: string, workspaceId: string, messageCount: number) =>
  ({ id, title: id, path: `/sessions/${id}.jsonl`, modifiedAt: 1, projectPath: "/project", workspaceId, projectName: "project", messageCount });

/**
 * A window like the real one: what is on screen is live, but each actions object writes to the
 * composer that was on screen when it was made. It starts on a used thread of another project;
 * `opens` is what opening the customization project shows, as the host does: a page of its own
 * with no messages yet (the project is not listed, so no draft can be made), or a thread already used.
 */
function windowActions(opens: "empty" | "used" = "empty") {
  const drafts = new Map<string, string>();
  const index = new ThreadStore();
  const sessions = [session("s1", "ws_other", 3)];
  const publish = () => index.applyThreadIndex({ projects: [], sessions: sessions as never });
  publish();
  let key = "s1";
  let thread: Thread = { sessionId: "s1", draftPending: false, workspaceId: "ws_other", cwd: "/home/dev/project" };
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((listener) => listener());
  const newSession = vi.fn((request?: { workspace?: string }) => {
    // The window lists a project once it has a used thread.
    if (!sessions.some((entry) => entry.workspaceId === request?.workspace && entry.messageCount > 0)) return;
    key = "draft";
    thread = { draftPending: false, workspaceId: request?.workspace ?? "", cwd: DIRECTORY };
    changed();
  });
  const actionsFor = (own: string) => ({
    notify: vi.fn(),
    closeSettings: vi.fn(),
    focusComposer: vi.fn(),
    openWorkspace: vi.fn(async () => {
      if (thread.workspaceId === PROJECT.workspaceId) return true;
      const id = opens === "empty" ? "s_empty" : "s_used";
      sessions.push(session(id, PROJECT.workspaceId, opens === "empty" ? 0 : 2));
      publish();
      key = id;
      thread = { sessionId: id, draftPending: false, workspaceId: PROJECT.workspaceId, cwd: DIRECTORY };
      changed();
      return true;
    }),
    newSession,
    activeThread: () => thread,
    composerDraft: () => drafts.get(own) ?? "",
    setComposerDraft: vi.fn((text: string) => { drafts.set(own, text); }),
    sendPrompt: vi.fn(),
  });
  const palette = actionsFor("s1");
  const onScreen = new Map<string, ReturnType<typeof actionsFor>>([["s1", palette]]);
  const current = () => { if (!onScreen.has(key)) onScreen.set(key, actionsFor(key)); return onScreen.get(key)!; };
  return {
    app: palette,
    /** What the palette hands the command: the actions of the thread it was opened from. */
    actions: palette as unknown as WorkbenchActions,
    current,
    draft: (name: string) => drafts.get(name) ?? "",
    /** Draws the region with the actions of whatever is on screen, as the workbench does. */
    Screen: ({ region }: { region: { Component: unknown } }) => {
      const [, bump] = useState(0);
      useEffect(() => { const listener = () => bump((n) => n + 1); listeners.add(listener); return () => { listeners.delete(listener); }; }, []);
      const Region = region.Component as (props: { actions: WorkbenchActions; snapshot: never }) => null;
      return <ThreadStoreContext.Provider value={index}><Region actions={current() as unknown as WorkbenchActions} snapshot={undefined as never} /></ThreadStoreContext.Provider>;
    },
  };
}

const host = (invoke = vi.fn(async (command: string): Promise<unknown> => command === "customization-project" ? PROJECT : { directory: DIRECTORY, packages: 0 })) => ({ invoke, onEvent: () => () => undefined });

/** The command as registered, with the region mounted the way the workbench mounts it. */
function mounted(win: ReturnType<typeof windowActions>) {
  const invoke = vi.fn(async (_id: string, command: string): Promise<unknown> => command === "customization-project" ? PROJECT : command === "list" ? { packages: [] } : { directory: DIRECTORY, packages: 0 });
  const { registry } = createKitHarness(invoke);
  registry.activate(packagesExtension);
  const region = registry.getRegions("composer-above").find((entry) => entry.id === "packages.customize-actions")!;
  const command = registry.getCommands().find((entry) => entry.id === "packages.customize")!;
  render(<win.Screen region={region} />);
  return { invoke, run: () => command.run(win.actions) };
}

describe("Customize Tau…", () => {
  it("puts the prompt's start into the empty page the project opens on, and sends nothing", async () => {
    const win = windowActions("empty");
    const { invoke, run } = mounted(win);
    await run();
    expect(invoke).toHaveBeenCalledWith(PACKAGES_EXTENSION_ID, "customization-project", undefined);
    expect(win.app.openWorkspace).toHaveBeenCalledWith("ws1_customizations");
    await waitFor(() => expect(win.draft("s_empty")).toBe(CUSTOMIZE_PROMPT_PREFIX));
    expect(CUSTOMIZE_PROMPT_PREFIX).toBe("Change Tau: ");
    // The thread it was started from keeps its composer, and no second page is made.
    expect(win.draft("s1")).toBe("");
    expect(win.app.newSession).not.toHaveBeenCalled();
    expect(win.current().focusComposer).toHaveBeenCalled();
    expect(win.app.sendPrompt).not.toHaveBeenCalled();
  });

  it("opens a draft when the project opens on a thread already used, and leaves that thread alone", async () => {
    const win = windowActions("used");
    const { run } = mounted(win);
    await run();
    await waitFor(() => expect(win.draft("draft")).toBe(CUSTOMIZE_PROMPT_PREFIX));
    expect(win.app.newSession).toHaveBeenCalledTimes(1);
    expect(win.app.newSession).toHaveBeenCalledWith({ workspace: "ws1_customizations" });
    expect(win.draft("s_used")).toBe("");
    expect(win.draft("s1")).toBe("");
  });

  it("tells the no-worktree rule about the folder before the project opens", async () => {
    const win = windowActions();
    const order: string[] = [];
    win.app.openWorkspace.mockImplementationOnce(async () => { order.push("open"); return true; });
    await startCustomization(host(), win.actions, createPendingPrefix(), (directory) => order.push(directory));
    expect(order).toEqual([DIRECTORY, "open"]);
  });

  it("takes the same page the second time and does not make another", async () => {
    const win = windowActions("used");
    const { run } = mounted(win);
    await run();
    await waitFor(() => expect(win.draft("draft")).toBe(CUSTOMIZE_PROMPT_PREFIX));
    await run();
    await wait(50);
    expect(win.app.newSession).toHaveBeenCalledTimes(1);
    expect(win.draft("draft")).toBe(CUSTOMIZE_PROMPT_PREFIX);
  });

  it("keeps what the user already typed on the page", async () => {
    const win = windowActions("empty");
    const { run } = mounted(win);
    await run();
    await waitFor(() => expect(win.draft("s_empty")).toBe(CUSTOMIZE_PROMPT_PREFIX));
    win.current().setComposerDraft("Change Tau: make the sidebar wider");
    await run();
    await wait(50);
    expect(win.draft("s_empty")).toBe("Change Tau: make the sidebar wider");
  });

  it("says so when no page of the project shows up in time", async () => {
    const win = windowActions();
    win.app.openWorkspace.mockImplementation(async () => true);
    const prefix = createPendingPrefix(30);
    await startCustomization(host(), win.actions, prefix);
    expect(prefix.getSnapshot()).toBeDefined();
    await waitFor(() => expect(win.app.notify).toHaveBeenCalledWith("The draft did not open. Try Customize Tau again.", "warning"));
    expect(prefix.getSnapshot()).toBeUndefined();
  });

  it("says why when the project cannot be made, and opens no draft", async () => {
    const { app, actions } = windowActions();
    await startCustomization(host(vi.fn(async () => { throw new Error("EACCES: permission denied"); })), actions, createPendingPrefix());
    expect(app.notify).toHaveBeenCalledWith("EACCES: permission denied", "error");
    expect(app.openWorkspace).not.toHaveBeenCalled();
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
    expect(command?.group).toBe("Extensions");
    await command?.run(windowActions().actions);
    expect(invoke).toHaveBeenCalledWith(PACKAGES_EXTENSION_ID, "customization-project", undefined);
    expect(registered).toHaveLength(1);
    expect(registered[0]!(DIRECTORY)).toBe(true);
    expect(registered[0]!(`${DIRECTORY}/`)).toBe(true);
    expect(registered[0]!("/home/dev/project")).toBe(false);
  });

  it("is a button at the top of Settings → Customize, with a sentence while nothing is installed", async () => {
    const invoke = vi.fn(async (_id: string, command: string): Promise<unknown> => command === "customization-project" ? PROJECT : command === "list" ? { packages: [] } : { directory: DIRECTORY, packages: 0 });
    const { registry } = createKitHarness(invoke);
    registry.activate(packagesExtension);
    const win = windowActions();
    const bind = registry.getRegions("composer-above").find((region) => region.id === "packages.customize-actions")!;
    const section = registry.getSettingsSections("customize").find((entry) => entry.id === "packages.customize")!;
    render(<><win.Screen region={bind as never} /><section.Component onNotify={vi.fn()} onChanged={vi.fn()} /></>);

    expect(await screen.findByText(/Nothing is installed yet/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Customize Tau…" }));
    await waitFor(() => expect(win.draft("s_empty")).toBe(CUSTOMIZE_PROMPT_PREFIX));
    expect(win.app.closeSettings).toHaveBeenCalled();
    expect(win.app.sendPrompt).not.toHaveBeenCalled();
  });

  it("drops the sentence once something is installed", async () => {
    const invoke = vi.fn(async (_id: string, command: string): Promise<unknown> => command === "list" ? { packages: [] } : { directory: DIRECTORY, packages: 2 });
    const { registry } = createKitHarness(invoke);
    registry.activate(packagesExtension);
    const section = registry.getSettingsSections("customize").find((entry) => entry.id === "packages.customize")!;
    render(<section.Component onNotify={vi.fn()} onChanged={vi.fn()} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(PACKAGES_EXTENSION_ID, "list", undefined));
    // Both answers in, and the section has drawn them.
    await act(async () => { await Promise.all(invoke.mock.results.map((result) => result.value)); });
    expect(screen.getByRole("button", { name: "Customize Tau…" })).toBeTruthy();
    expect(screen.queryByText(/Nothing is installed yet/u)).toBeNull();
  });
});
