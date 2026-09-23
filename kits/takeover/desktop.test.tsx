// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import takeoverKit from "./desktop.js";
import {
  COMPUTER_USE_SCREEN_SERVICE,
  PREVIEW_BROWSER_SERVICE,
  PREVIEW_COOKIE_IMPORT_SERVICE,
  TAKEOVER_EXTENSION_ID,
  TAKEOVER_STATE_EVENT,
  WORKSPACE_STORE_SERVICE,
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

function setup(initial: Takeover[] = [], platform: Record<string, unknown> = {}) {
  const calls: Array<[string, string, unknown]> = [];
  const invoke = vi.fn(async (extensionId: string, command: string, input?: unknown) => {
    calls.push([extensionId, command, input]);
    if (extensionId === TAKEOVER_EXTENSION_ID && command === "state") return initial;
    if (extensionId === "tau.preview" && command === "state") return { url: "http://127.0.0.1:8741/login" };
    return true;
  });
  const { registry } = createKitHarness(invoke, undefined, platform);
  const preview = { open: vi.fn(async () => undefined), jump: vi.fn(async () => undefined) } satisfies PreviewBrowserService;
  const cookies = { importSite: vi.fn<PreviewCookieImportService["importSite"]>(async () => ({ imported: 2, skipped: 0, skippedSites: [], profile: "default", reloaded: true })) };
  const screen = { load: async () => ({ window: { app: "TextEdit" } }), bringToFront: vi.fn(async () => undefined) } satisfies ComputerUseScreenService;
  let rowMark: ((props: { session: { id: string } }) => unknown) | undefined;
  registry.activate({
    id: "test.services",
    name: "Services",
    activate: (context) => {
      context.provideService(PREVIEW_BROWSER_SERVICE, preview);
      context.provideService(PREVIEW_COOKIE_IMPORT_SERVICE, cookies);
      context.provideService(COMPUTER_USE_SCREEN_SERVICE, screen);
      context.provideService(WORKSPACE_STORE_SERVICE, { registerThreadRowAccessory: (mark: typeof rowMark) => { rowMark = mark; return () => { rowMark = undefined; }; } });
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
    notify: vi.fn(),
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
  return { registry, calls, preview, cookies, screen, actions, publish, card, stage, rowMark: () => rowMark };
}

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
    fireEvent.click(view.getByRole("button", { name: "Show the page" }));
    await waitFor(() => expect(stage).toHaveLength(1));
    expect(preview.jump).toHaveBeenCalledWith({ kind: "browser" }, actions);
    fireEvent.click(view.getByRole("button", { name: "Done" }));
    expect(stage).toHaveLength(0);
  });

  it("raises the driven app by name, and opens a page of the user's own browser there", async () => {
    const { card, publish, preview, actions } = setup();
    const view = card();
    publish([takeover({ kind: "window" })]);
    fireEvent.click(await waitFor(() => view.getByRole("button", { name: "Show TextEdit" })));
    await waitFor(() => expect(preview.jump).toHaveBeenCalledWith({ kind: "app", threadId: "s1" }, actions));

    publish([takeover({ kind: "browser", url: "https://example.test/device" })]);
    expect(view.queryByRole("button", { name: "Your passwords" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Open in browser" }));
    expect(actions.openExternal).toHaveBeenCalledWith("https://example.test/device");
  });

  it("offers the ways to a password only on a click, and imports only the page's site", async () => {
    const { card, publish, cookies, actions } = setup();
    const view = card();
    publish([takeover({ kind: "preview" })]);
    expect(view.queryByRole("group", { name: "Your passwords" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Your passwords" }));
    const ways = view.getByRole("group", { name: "Your passwords" });
    expect(ways.textContent).toMatch(/cannot reach your password manager/u);
    const bring = await waitFor(() => view.getByRole("button", { name: "Bring the session over" }));
    expect(cookies.importSite).not.toHaveBeenCalled();
    fireEvent.click(view.getAllByRole("button", { name: "Open in browser" })[0]!);
    expect(actions.openExternal).toHaveBeenCalledWith("http://127.0.0.1:8741/login");
    fireEvent.click(bring);
    await waitFor(() => expect(view.getByRole("status").textContent).toMatch(/Imported 2 cookies into the Preview; the page reloaded/u));
    expect(cookies.importSite).toHaveBeenCalledWith({ site: "127.0.0.1" });
  });

  it("marks the thread's rail row", () => {
    const { publish, rowMark } = setup();
    const Mark = rowMark() as (props: { session: { id: string } }) => React.JSX.Element | null;
    const view = render(<><Mark session={{ id: "s1" }} /><Mark session={{ id: "s2" }} /></>);
    expect(view.queryByRole("img")).toBeNull();
    publish([takeover({ kind: "preview" })]);
    expect(view.getAllByRole("img").map((mark) => mark.getAttribute("aria-label"))).toEqual(["Your turn: Sign in to staging"]);
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
