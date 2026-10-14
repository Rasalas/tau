// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCardProps, UiToolRun, WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import htmlPages from "./desktop.js";
import { createPageCard } from "./page-card.js";
import { holdPreviewLinks, openPageLink } from "./links.js";
import { PageView, linkRequest } from "./page-view.js";
import { HTML_PAGE_COMMANDS, HTML_PAGE_STAGE_TAB, PREVIEW_LINKS_SERVICE, type HtmlPageOpen, type PreviewLinksService } from "./protocol.js";

const tool = (overrides: Partial<UiToolRun> = {}): UiToolRun => ({
  id: "call1", name: "mcp__tau__show_html_page", args: { title: "Totals" }, status: "done", startedAt: 1,
  output: 'Showing "Totals" to the user above your reply. [tau-html-page:abc123XYZ]', ...overrides,
});

const ready = (extra: Partial<Extract<HtmlPageOpen, { state: "ready" }>> = {}): HtmlPageOpen => ({ state: "ready", path: "/resources/frame-1", title: "Totals", maxHeight: 500, origins: [], ...extra });

type Invoke = (command: string, input?: any) => Promise<unknown>;

function setup(invoke: Invoke, tools: UiToolRun[] = [tool()]) {
  const host = { invoke: vi.fn(invoke), onEvent: () => () => undefined, resourceUrl: (path: string) => `https://host.test${path}` };
  const actions = { activeThread: () => ({ sessionId: "thread-1", draftPending: false }), openExternal: vi.fn(), openStageTab: vi.fn() } as unknown as WorkbenchActions;
  const Card = createPageCard(host);
  const view = render(<Card {...({ tools, actions } satisfies ToolCardProps)} />);
  return { host, actions, view };
}

const frame = () => document.querySelector("iframe") as HTMLIFrameElement | null;
const waitForFrame = async () => { await waitFor(() => expect(frame()).not.toBeNull()); return frame()!; };
const speak = (iframe: HTMLIFrameElement, data: unknown) => act(() => { window.dispatchEvent(new MessageEvent("message", { data, source: iframe.contentWindow })); });

beforeEach(() => { document.documentElement.dataset.theme = "light"; });
afterEach(() => { cleanup(); delete (navigator as { userActivation?: unknown }).userActivation; });

describe("HTML page card", () => {
  it("asks the host for the page the result names, with Tau's tokens, and frames the capability", async () => {
    document.documentElement.style.setProperty("--stage", "light-dark(#fff, #000)");
    const { host } = setup(async () => ready());
    const iframe = await waitForFrame();
    expect(iframe.getAttribute("src")).toBe("https://host.test/resources/frame-1");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(host.invoke).toHaveBeenCalledWith(HTML_PAGE_COMMANDS.open, expect.objectContaining({ threadId: "thread-1", id: "abc123XYZ", colorScheme: "light", theme: expect.objectContaining({ "--background": "light-dark(#fff, #000)" }) }));
    expect(screen.getByText("Totals")).toBeTruthy();
  });

  it("sizes the frame from the page's report, up to the page's cap", async () => {
    setup(async () => ready());
    const iframe = await waitForFrame();
    const report = (height: number) => speak(iframe, { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height } });
    const heightOf = () => (document.querySelector(".sandbox-frame") as HTMLElement).style.height;
    report(240);
    await waitFor(() => expect(heightOf()).toBe("240px"));
    report(9000);
    await waitFor(() => expect(heightOf()).toBe("500px"));
  });

  it("opens a link the page hands over only while the user's click is live", async () => {
    const { actions } = setup(async () => ready());
    const iframe = await waitForFrame();
    const post = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => undefined);
    const link = (id: string, url: string) => ({ jsonrpc: "2.0", id, method: "ui/open-link", params: { url } });
    // The frame speaks first, so the card may answer.
    speak(iframe, { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 100 } });

    speak(iframe, link("l1", "https://example.com/doc"));
    expect(actions.openExternal).not.toHaveBeenCalled();
    expect(post.mock.calls.at(-1)?.[0]).toMatchObject({ id: "l1", error: { code: -32000 } });

    Object.defineProperty(navigator, "userActivation", { configurable: true, value: { isActive: true } });
    iframe.focus();
    speak(iframe, link("l2", "javascript:alert(1)"));
    expect(actions.openExternal).not.toHaveBeenCalled();
    speak(iframe, link("l3", "https://example.com/doc"));
    expect(actions.openExternal).toHaveBeenCalledWith("https://example.com/doc");
    expect(post.mock.calls.at(-1)?.[0]).toEqual({ jsonrpc: "2.0", id: "l3", result: {} });
    // A message from any other window is not the page.
    act(() => { window.dispatchEvent(new MessageEvent("message", { data: link("l4", "https://evil.test/"), source: window })); });
    expect(actions.openExternal).toHaveBeenCalledTimes(1);
  });

  it("opens a clicked image in the viewer, only from a live click and only images Tau may draw", async () => {
    setup(async () => ready({ origins: ["https://cdn.example.com"] }));
    const iframe = await waitForFrame();
    const png = "data:image/png;base64,iVBORw0KGgo=";
    const open = { jsonrpc: "2.0", method: "tau/open-images", params: { index: 1, images: [
      { src: "javascript:alert(1)", alt: "script" },
      { src: png, alt: "The share question" },
      { src: "https://cdn.example.com/b.webp", alt: "" },
      { src: "https://tracker.test/pixel.png", alt: "undeclared" },
    ] } };
    speak(iframe, open);
    expect(screen.queryByRole("dialog")).toBeNull();

    Object.defineProperty(navigator, "userActivation", { configurable: true, value: { isActive: true } });
    iframe.focus();
    speak(iframe, open);
    const dialog = await screen.findByRole("dialog", { name: "The share question" });
    expect(dialog.querySelector(".lightbox-stage img")?.getAttribute("src")).toBe(png);
    expect(screen.getByText(/1 of 2/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next media" }));
    expect(screen.getByRole("dialog", { name: "Totals" }).querySelector(".lightbox-stage img")?.getAttribute("src")).toBe("https://cdn.example.com/b.webp");
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("expands a page of images into the viewer", async () => {
    setup(async () => ready());
    const iframe = await waitForFrame();
    const post = vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => undefined);
    speak(iframe, { jsonrpc: "2.0", method: "tau/notifications/page-media", params: { gallery: true } });
    fireEvent.click(await screen.findByRole("button", { name: "Expand" }));
    const request = post.mock.calls.at(-1)?.[0] as { id: string; method: string };
    expect(request.method).toBe("tau/list-images");
    // Only the answer to this request counts.
    speak(iframe, { jsonrpc: "2.0", id: "other", result: { images: [{ src: "data:image/png;base64,AAAA", alt: "Wrong" }] } });
    expect(screen.queryByRole("dialog")).toBeNull();
    speak(iframe, { jsonrpc: "2.0", id: request.id, result: { images: [{ src: "data:image/png;base64,AAAA", alt: "Window" }] } });
    expect(await screen.findByRole("dialog", { name: "Window" })).toBeTruthy();
  });

  it("lets Preview Kit decide where a link opens, and falls back to the system browser", async () => {
    const { actions } = setup(async () => ready());
    const iframe = await waitForFrame();
    vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(() => undefined);
    Object.defineProperty(navigator, "userActivation", { configurable: true, value: { isActive: true } });
    iframe.focus();
    const link = (id: string, params: object) => ({ jsonrpc: "2.0", id, method: "ui/open-link", params: { url: "https://example.com/doc", ...params } });
    speak(iframe, { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 100 } });

    const open = vi.fn<PreviewLinksService["open"]>((url, event) => !event.metaKey && !event.ctrlKey);
    const release = holdPreviewLinks({ open });
    speak(iframe, link("l1", {}));
    expect(open).toHaveBeenLastCalledWith("https://example.com/doc", expect.objectContaining({ metaKey: false, ctrlKey: false }), actions);
    expect(actions.openExternal).not.toHaveBeenCalled();
    speak(iframe, link("l2", { metaKey: true }));
    expect(open).toHaveBeenLastCalledWith("https://example.com/doc", expect.objectContaining({ metaKey: true }), actions);
    expect(actions.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/doc");

    release();
    speak(iframe, link("l3", {}));
    expect(open).toHaveBeenCalledTimes(2);
    expect(actions.openExternal).toHaveBeenCalledTimes(2);
  });

  it("says so when the page is gone, and shows a failed call's reason", async () => {
    setup(async () => ({ state: "missing" }));
    await screen.findByText("This page is no longer stored.");
    cleanup();
    setup(async () => ready(), [tool({ status: "error", output: "origins: only https origins can be declared." })]);
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("origins: only https origins can be declared.")).toBeTruthy();
    expect(frame()).toBeNull();
  });

  it("shows a status line while the call runs and mounts nothing", () => {
    const { host } = setup(async () => ready(), [tool({ status: "running", output: undefined })]);
    expect(screen.getByText("Preparing")).toBeTruthy();
    expect(host.invoke).not.toHaveBeenCalled();
  });

  it("offers to open the page in a stage tab", async () => {
    const { actions } = setup(async () => ready());
    await waitForFrame();
    fireEvent.click(screen.getByRole("button", { name: "Open in a tab" }));
    expect(actions.openStageTab).toHaveBeenCalledWith(HTML_PAGE_STAGE_TAB, { threadId: "thread-1", id: "abc123XYZ", title: "Totals" });
  });

  it("gives the frame back when the card goes away", async () => {
    const { host, view } = setup(async () => ready());
    await waitForFrame();
    view.unmount();
    await waitFor(() => expect(host.invoke).toHaveBeenCalledWith(HTML_PAGE_COMMANDS.release, { path: "/resources/frame-1" }));
  });
});

describe("HTML page in a stage tab", () => {
  it("fills the room the tab has once the page is ready", async () => {
    class Watcher { constructor(private readonly run: () => void) {} observe() { this.run(); } disconnect() { /* nothing to release */ } }
    vi.stubGlobal("ResizeObserver", Watcher);
    const client = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(640);
    try {
      const host = { invoke: vi.fn(async () => ready()), onEvent: () => () => undefined, resourceUrl: (path: string) => `https://host.test${path}` };
      const actions = { activeThread: () => undefined, openExternal: vi.fn() } as unknown as WorkbenchActions;
      const titles: string[] = [];
      render(<PageView host={host} actions={actions} threadId="thread-1" pageId="abc123XYZ" variant="tab" onTitle={(title) => titles.push(title)} />);
      await waitForFrame();
      await waitFor(() => expect((document.querySelector(".sandbox-frame") as HTMLElement).style.height).toBe("640px"));
      expect(titles).toEqual(["Totals"]);
      expect(screen.queryByRole("button", { name: "Expand" })).toBeNull();
    } finally {
      client.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe("link requests", () => {
  const request = (params: unknown) => ({ jsonrpc: "2.0", id: "l1", method: "ui/open-link", params });

  it("reads the url and the modifiers held, and refuses what is not a web link", () => {
    expect(linkRequest(request({ url: "https://a.test/", metaKey: true, ctrlKey: "yes" }))).toEqual({ id: "l1", url: "https://a.test/", metaKey: true, ctrlKey: false });
    expect(linkRequest(request({ url: "https://a.test/" }))).toMatchObject({ metaKey: false, ctrlKey: false });
    expect(linkRequest(request({ url: "javascript:alert(1)" }))).toBeUndefined();
    expect(linkRequest(request(undefined))).toBeUndefined();
    expect(linkRequest({ ...request({ url: "https://a.test/" }), id: undefined })).toBeUndefined();
  });
});

describe("HTML pages kit registration", () => {
  it("claims the tool under both of its names and registers the stage tab", () => {
    const { registry } = createKitHarness();
    registry.activate(htmlPages);
    const card = registry.toolCardFor(tool({ name: "show_html_page" }));
    expect(card?.id).toBe("html-pages.page");
    expect(registry.toolCardFor(tool({ name: "mcp__tau__show_html_page" }))?.id).toBe("html-pages.page");
    expect(registry.toolCardFor(tool({ name: "mcp__other__show_html_page" }))).toBeUndefined();
    expect(registry.getStageTabKinds().map((kind) => kind.kind)).toEqual([HTML_PAGE_STAGE_TAB]);
    registry.deactivate(htmlPages.id);
    expect(registry.toolCardFor(tool({ name: "show_html_page" }))).toBeUndefined();
  });

  it("takes Preview Kit's link service while it is published, and lets go when it is withdrawn", () => {
    const { registry } = createKitHarness();
    const open = vi.fn<PreviewLinksService["open"]>(() => true);
    registry.activate(htmlPages);
    const provider = { id: "test.preview", name: "Preview stand-in", activate: (context: { provideService<T>(id: string, value: T): () => void }) => context.provideService<PreviewLinksService>(PREVIEW_LINKS_SERVICE, { open }) };
    registry.activate(provider);
    const actions = { openPanel: vi.fn(), openExternal: vi.fn() };
    openPageLink("https://example.com/", { metaKey: false, ctrlKey: false }, actions);
    expect(open).toHaveBeenCalledOnce();
    expect(actions.openExternal).not.toHaveBeenCalled();
    registry.deactivate(provider.id);
    openPageLink("https://example.com/", { metaKey: false, ctrlKey: false }, actions);
    expect(actions.openExternal).toHaveBeenCalledOnce();
    registry.deactivate(htmlPages.id);
  });
});
