// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, WorkbenchActions } from "tau";
import { HostClientProvider, createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import takeoverKit from "./desktop.js";
import { TakeoverLine, isGenericRuntime, jumpLabel, windowTooltip } from "./card.js";
import {
  COMPUTER_USE_SCREEN_SERVICE,
  PREVIEW_BROWSER_SERVICE,
  PREVIEW_COOKIE_IMPORT_SERVICE,
  TAKEOVER_EXTENSION_ID,
  TAKEOVER_STATE_EVENT,
  type ComputerUseScreenService,
  type PreviewBrowserService,
  type PreviewCookieImportService,
  type Takeover,
} from "./protocol.js";

const registries: Array<{ deactivate(id: string): void }> = [];
afterEach(() => {
  cleanup();
  for (const registry of registries.splice(0)) registry.deactivate(takeoverKit.id);
  vi.restoreAllMocks();
});

const takeover = (target: Takeover["target"], threadId = "s1"): Takeover => ({
  id: `t-${threadId}-${target.kind}`, threadId, reason: "Sign in to staging", target, since: 1, title: "Fix the login", sessionFile: `/sessions/${threadId}.jsonl`,
});

function setup(initial: Takeover[] = [], platform: Record<string, unknown> = {}, previewExtras: Partial<PreviewBrowserService> = {}) {
  const calls: Array<[string, string, unknown]> = [];
  const invoke = vi.fn(async (extensionId: string, command: string, input?: unknown) => {
    calls.push([extensionId, command, input]);
    if (extensionId === TAKEOVER_EXTENSION_ID && command === "state") return initial;
    if (extensionId === "tau.preview" && command === "state") return { url: "http://127.0.0.1:8741/login" };
    return true;
  });
  const { registry } = createKitHarness(invoke, undefined, platform);
  const release = vi.fn();
  const hold = vi.fn<NonNullable<PreviewBrowserService["hold"]>>(() => release);
  const preview = { open: vi.fn(async () => undefined), jump: vi.fn(async () => undefined), hold, ...previewExtras } satisfies PreviewBrowserService;
  const cookies = { importSite: vi.fn<PreviewCookieImportService["importSite"]>(async () => ({ imported: 2, skipped: 0, skippedSites: [], profile: "default", reloaded: true })) };
  const screen = { load: async () => ({ window: { app: "TextEdit" } }), bringToFront: vi.fn(async () => undefined), icon: vi.fn(async () => "data:image/png;base64,SUNPTg==") } satisfies ComputerUseScreenService;
  registry.activate({
    id: "test.services",
    name: "Services",
    activate: (context) => {
      context.provideService(PREVIEW_BROWSER_SERVICE, preview);
      context.provideService(PREVIEW_COOKIE_IMPORT_SERVICE, cookies);
      context.provideService(COMPUTER_USE_SCREEN_SERVICE, screen);
    },
  });
  registry.activate(takeoverKit);
  registries.push(registry);
  const publish = (list: Takeover[]) => act(() => {
    registry.dispatchExtensionEvent({ type: "extension-event", extensionId: TAKEOVER_EXTENSION_ID, name: TAKEOVER_STATE_EVENT, payload: { takeovers: list } });
  });
  const stage: Array<{ kind: "panel"; panelId: string; id: string }> = [];
  const actions = {
    openPanel: vi.fn(),
    openExternal: vi.fn(),
    openSettings: vi.fn(),
    notify: vi.fn(),
    closePanel: vi.fn(),
    toast: vi.fn(() => ({ update: () => undefined, dismiss: vi.fn() })),
    switchSession: vi.fn(async () => true),
    activeThread: () => ({ sessionId: "s1", draftPending: false }),
    activeStageTab: () => stage[0],
    togglePanelMaximized: vi.fn(() => { if (stage.length) stage.pop(); else stage.push({ kind: "panel", panelId: "preview", id: "panel:preview" }); }),
  } as unknown as WorkbenchActions & { togglePanelMaximized: ReturnType<typeof vi.fn> };
  const card = (sessionId = "s1") => {
    const { Component } = registry.getRegions("composer-above").find((region) => region.id === "takeover.card")!;
    return render(<Component snapshot={{ sessionId } as HostSnapshot} actions={actions} />);
  };
  return { registry, calls, preview, cookies, screen, actions, publish, card, stage, hold, release, rowStatuses: () => registry.getThreadRowMarks() };
}

describe("Takeover card on a device away from the host", () => {
  it("shows what to take over as it looks now, and opens it here to drive", async () => {
    const stop = vi.fn();
    const watch = vi.fn((_target: unknown, _width: number, onFrame: (picture: { url: string; width: number; height: number }) => void) => {
      onFrame({ url: "data:image/jpeg;base64,SlBFRw==", width: 480, height: 240 });
      return stop;
    });
    const { card, publish, preview, actions } = setup([], {}, { remote: () => true, watch });
    const view = card();
    publish([takeover({ kind: "window" })]);
    expect(watch).toHaveBeenCalledWith({ kind: "app", threadId: "s1" }, 480, expect.any(Function));
    expect(view.getByRole("button", { name: "Open what you take over" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Take over here" }));
    await waitFor(() => expect(preview.jump).toHaveBeenCalledWith({ kind: "app", threadId: "s1" }, actions));
    // No stage to move a phone's Preview to.
    expect(actions.togglePanelMaximized).not.toHaveBeenCalled();
    publish([]);
    expect(stop).toHaveBeenCalled();
  });

  it("keeps Done and Cancel from a Read-only device, and says why", () => {
    const { registry, publish, actions } = setup();
    const { Component } = registry.getRegions("composer-above").find((region) => region.id === "takeover.card")!;
    const view = render(<HostClientProvider client={createFakeHostClient({ isReadOnly: () => true })}><Component snapshot={{ sessionId: "s1" } as HostSnapshot} actions={actions} /></HostClientProvider>);
    publish([takeover({ kind: "preview" })]);
    expect((view.getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.getByText(/paired Read only/u)).toBeTruthy();
  });

  it("offers none of the host's browsers, which are not on this device", async () => {
    const { card, publish, preview } = setup([], {}, { remote: () => true, watch: () => () => undefined });
    const view = card();
    publish([takeover({ kind: "preview", url: "http://127.0.0.1:8741/login" })]);
    expect(view.getByRole("button", { name: "Take over here" })).toBeTruthy();
    expect(view.queryByRole("button", { name: /Bring my browser session over|Open in my browser/u })).toBeNull();
    // A phone opens the sheet on a tap, not by itself.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(preview.jump).not.toHaveBeenCalled();
  });
});

describe("Takeover card", () => {
  it("shows the request above the composer of its thread, and Done and Cancel answer the host", async () => {
    const { card, publish, calls } = setup();
    const view = card();
    expect(view.queryByRole("region", { name: "Your turn" })).toBeNull();
    const request = takeover({ kind: "preview", url: "http://127.0.0.1:8741/login" });
    publish([request]);
    const region = view.getByRole("region", { name: "Your turn" });
    expect(region.textContent).toContain("Sign in to staging");
    fireEvent.click(view.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(calls).toContainEqual([TAKEOVER_EXTENSION_ID, "done", { id: request.id }]));

    publish([]);
    expect(view.queryByRole("region", { name: "Your turn" })).toBeNull();
    const other = takeover({ kind: "none" });
    publish([other]);
    expect(view.queryByRole("button", { name: /^Show|Open in browser/u })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(calls).toContainEqual([TAKEOVER_EXTENSION_ID, "cancel", { id: other.id }]));
  });

  it("reads the host's list again when the link comes back, so a request finished on another device goes", async () => {
    const hostList = [takeover({ kind: "none" })];
    const { card, publish, registry } = setup(hostList);
    const view = card();
    publish([...hostList]);
    expect(view.getByRole("region", { name: "Your turn" })).toBeTruthy();

    // Done on the phone while this window's link was down: the push that said so never came.
    hostList.splice(0);
    act(() => { registry.dispatchWorkbenchEvent({ type: "host-connection", state: "reconnecting" }); });
    act(() => { registry.dispatchWorkbenchEvent({ type: "host-connection", state: "connected" }); });

    await waitFor(() => expect(view.queryByRole("region", { name: "Your turn" })).toBeNull());
  });

  it("leaves a thread that is not on screen alone", () => {
    const { card, publish } = setup();
    const view = card("s2");
    publish([takeover({ kind: "preview" })]);
    expect(view.queryByRole("region", { name: "Your turn" })).toBeNull();
  });

  it("brings the Preview forward on the stage, and puts it back when the user is done", async () => {
    const { card, publish, preview, actions, stage } = setup();
    const view = card();
    const request = takeover({ kind: "preview" });
    publish([request]);
    // No click: on the host's machine the page comes forward with the card.
    expect(view.queryByRole("button", { name: "Show the page" })).toBeNull();
    await waitFor(() => expect(stage).toHaveLength(1));
    expect(preview.jump).toHaveBeenCalledWith({ kind: "browser" }, actions);
    fireEvent.click(view.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(stage).toHaveLength(0));
  });

  it("raises the driven app by name, and opens a page of the user's own browser there", async () => {
    const { card, publish, preview, actions } = setup();
    const view = card();
    publish([takeover({ kind: "window" })]);
    // The app is the button's icon and tooltip; the text says what happens.
    const show = await waitFor(() => view.getByRole("button", { name: "Show window" }));
    await waitFor(() => expect(show.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,SUNPTg=="));
    fireEvent.click(show);
    await waitFor(() => expect(preview.jump).toHaveBeenCalledWith({ kind: "app", threadId: "s1" }, actions));

    publish([takeover({ kind: "browser", url: "https://example.test/device" })]);
    expect(view.queryByRole("button", { name: "Bring my browser session over" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Open in my browser" }));
    expect(actions.openExternal).toHaveBeenCalledWith("https://example.test/device");
  });

  it("links a consent request directly to its settings page", async () => {
    const { card, publish, actions, preview } = setup();
    const view = card();
    publish([takeover({ kind: "settings", page: "devices.settings" })]);
    fireEvent.click(await view.findByRole("button", { name: "Open settings" }));
    expect(actions.openSettings).toHaveBeenCalledWith("devices.settings");
    expect(preview.jump).not.toHaveBeenCalled();
    expect(view.queryByRole("button", { name: "Show window" })).toBeNull();
  });

  it("names a window by its title, not by the runtime it runs in", () => {
    expect(windowTooltip({ app: "TextEdit", title: "notes.txt" })).toBe("Show TextEdit");
    for (const runtime of ["Electron", "java", "Python", "python3.12", "node", "Electron Helper"]) {
      expect(isGenericRuntime(runtime)).toBe(true);
      expect(windowTooltip({ app: runtime, title: "F13 test window" })).toBe("Show “F13 test window”");
    }
    expect(windowTooltip({ app: "Electron" })).toBe("Show the window the agent drives");
    expect(isGenericRuntime("Visual Studio Code")).toBe(false);
    expect(jumpLabel(takeover({ kind: "window" }))).toBe("Show window");
    expect(jumpLabel(takeover({ kind: "preview" }), true, true)).toBe("Watch here");
    expect(jumpLabel(takeover({ kind: "preview" }))).toBeUndefined();
  });

  it("says what is held and for how long, and brings the page's session over only on a click", async () => {
    const { card, publish, cookies, actions } = setup();
    const view = card();
    publish([takeover({ kind: "preview" })]);
    const region = view.getByRole("region", { name: "Your turn" });
    expect(region.textContent).toMatch(/waits up to 30 min/u);
    expect(region.textContent).toMatch(/Sign in to staging\. The agent's preview and computer-use calls are held until you press Done\./u);
    const bring = await waitFor(() => view.getByRole("button", { name: "Bring my browser session over" }));
    expect(cookies.importSite).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Open in my browser" }));
    expect(actions.openExternal).toHaveBeenCalledWith("http://127.0.0.1:8741/login");
    fireEvent.click(bring);
    await waitFor(() => expect(view.getByRole("status").textContent).toMatch(/Imported 2 cookies into the Preview; the page reloaded/u));
    expect(cookies.importSite).toHaveBeenCalledWith({ site: "127.0.0.1" });
  });

  it("names the page's host in mono where the agent's words name it", () => {
    const { card, publish } = setup();
    const view = card();
    publish([{ ...takeover({ kind: "preview", url: "http://staff.shop.local/login" }), reason: "Sign in to staff.shop.local in the preview" }]);
    expect(view.getByRole("region", { name: "Your turn" }).querySelector("code")?.textContent).toBe("staff.shop.local");
  });

  it("gives the thread's row the state Your turn on every client", () => {
    const { publish, rowStatuses } = setup();
    expect(rowStatuses()).toEqual({});
    publish([takeover({ kind: "preview" })]);
    expect(rowStatuses()).toEqual({ s1: expect.objectContaining({ label: "Your turn", hint: "Sign in to staging" }) });
    publish([]);
    expect(rowStatuses()).toEqual({});
  });

  it("holds the Preview while the user has a page or a window, with a bar that hands it back on a phone", async () => {
    const { publish, hold, release, calls, actions } = setup();
    publish([takeover({ kind: "none" })]);
    expect(hold).not.toHaveBeenCalled();
    const request = takeover({ kind: "preview" });
    publish([request]);
    expect(hold).toHaveBeenCalledTimes(1);
    const { Bar, Footer } = hold.mock.calls[0]![0];
    const view = render(<>{Bar ? <Bar actions={actions} /> : null}{Footer ? <Footer /> : null}</>);
    expect(view.getByRole("region", { name: "Your turn" }).textContent).toContain("Your turn · Sign in to staging");
    expect(view.container.textContent).toMatch(/streams to your phone\. Evidence is paused while you type\./u);
    fireEvent.click(view.getByRole("button", { name: "Done" }));
    expect(actions.closePanel).toHaveBeenCalledWith("preview");
    await waitFor(() => expect(calls).toContainEqual([TAKEOVER_EXTENSION_ID, "done", { id: request.id }]));
    publish([]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("says in the transcript that it waits for the user, then how it ended", () => {
    const tool = { id: "c1", name: "request_takeover", args: {}, status: "running" as const, startedAt: 1 };
    const view = render(<TakeoverLine tools={[tool]} actions={{} as WorkbenchActions} />);
    expect(view.container.textContent).toBe("Waiting for you · evidence paused");
    view.rerender(<TakeoverLine tools={[{ ...tool, status: "done", output: "The user is done and handed control back. Carry on." }]} actions={{} as WorkbenchActions} />);
    expect(view.container.textContent).toBe("You handed control back");
    view.rerender(<TakeoverLine tools={[{ ...tool, status: "error", output: "The user cancelled the takeover. Stop here." }]} actions={{} as WorkbenchActions} />);
    expect(view.container.textContent).toBe("You cancelled the takeover");
  });

  it("notifies a window without focus of a new request and opens its thread from the notification", async () => {
    const notify = vi.fn(async () => "clicked" as const);
    const { card, publish, actions } = setup([], { attention: { notify, setBadge: () => undefined } });
    card("s2");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    publish([takeover({ kind: "preview" })]);
    expect(notify).toHaveBeenCalledWith({ title: "Your turn: Fix the login", body: "Sign in to staging", tag: "tau.takeover:t-s1-preview" });
    await waitFor(() => expect(actions.switchSession).toHaveBeenCalledWith("/sessions/s1.jsonl"));
  });

  it("shows a toast in a focused window that looks at another thread", async () => {
    const { card, publish, actions } = setup();
    card("s2");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    publish([takeover({ kind: "preview" }, "s3")]);
    expect(actions.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Your turn: Fix the login", description: "Sign in to staging" }));
  });
});
