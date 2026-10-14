// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRAME_KEYDOWN_MESSAGE, FRAME_KEYS_MESSAGE, FRAME_SCHEME_MESSAGE } from "../../shared/sandbox-frame";
import { ExtensionRegistry, type WorkbenchActions } from "../extension-system";
import { isMacPlatform } from "../keybindings";
import { useAppKeybindings } from "../use-app-keybindings";
import { WorkbenchContext } from "../workbench-context";
import { SandboxFrame, type SandboxFrameHandle, type SandboxFrameProps } from "./SandboxFrame";

const base = { src: "tau-ext://resources/frame/a", title: "App", onMessage: () => undefined };

function frameOf(): HTMLIFrameElement {
  return screen.getByTitle("App") as HTMLIFrameElement;
}

function messageFrom(source: Window | null, data: unknown) {
  act(() => { window.dispatchEvent(new MessageEvent("message", { data, source })); });
}

function renderFrame(props: Partial<SandboxFrameProps> = {}) {
  return render(<SandboxFrame {...base} {...props} />);
}

function stubPopover() {
  const show = vi.fn();
  const hide = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "popover", { configurable: true, value: "", writable: true });
  Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable: true, value: show, writable: true });
  Object.defineProperty(HTMLElement.prototype, "hidePopover", { configurable: true, value: hide, writable: true });
  return { show, hide };
}

afterEach(() => {
  cleanup();
  for (const key of ["popover", "showPopover", "hidePopover"]) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

beforeEach(() => { document.documentElement.dataset.theme = "light"; });

describe("SandboxFrame isolation attributes", () => {
  it("sandboxes the frame without same-origin, popups or top navigation", () => {
    renderFrame();
    const frame = frameOf();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("srcdoc")).toBeNull();
    expect(frame.getAttribute("src")).toBe(base.src);
    expect(frame.getAttribute("allow")).toBe("");
  });

  it("delegates only the declared permissions", () => {
    renderFrame({ permissions: { camera: {}, clipboardWrite: {} } });
    expect(frameOf().getAttribute("allow")).toBe("camera; clipboard-write");
  });

  it("renders nothing until it has a source, and keeps the first one", () => {
    const view = renderFrame({ src: undefined });
    expect(screen.queryByTitle("App")).toBeNull();
    view.rerender(<SandboxFrame {...base} src="tau-ext://resources/frame/first" />);
    expect(frameOf().getAttribute("src")).toBe("tau-ext://resources/frame/first");
    view.rerender(<SandboxFrame {...base} src="tau-ext://resources/frame/second" />);
    expect(frameOf().getAttribute("src")).toBe("tau-ext://resources/frame/first");
  });
});

describe("SandboxFrame messages", () => {
  it("delivers only messages whose source is its own window", () => {
    const onMessage = vi.fn();
    renderFrame({ onMessage });
    const other = document.body.appendChild(document.createElement("iframe"));
    messageFrom(window, "from the page");
    messageFrom(other.contentWindow, "from another frame");
    messageFrom(null, "from nowhere");
    expect(onMessage).not.toHaveBeenCalled();
    messageFrom(frameOf().contentWindow, "from the app");
    expect(onMessage).toHaveBeenCalledExactlyOnceWith("from the app");
  });

  it("stops listening on unmount", () => {
    const onMessage = vi.fn();
    const view = renderFrame({ onMessage });
    const source = frameOf().contentWindow;
    view.unmount();
    messageFrom(source, "late");
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("posts to the document with target * once it loaded or spoke, and not after unmount", () => {
    const handle = createRef<SandboxFrameHandle>();
    const view = renderFrame({ handleRef: handle });
    const target = frameOf().contentWindow!;
    const spy = vi.spyOn(target, "postMessage");
    handle.current!.post("early");
    expect(spy).not.toHaveBeenCalledWith("early", "*");
    messageFrom(target, { hello: true });
    handle.current!.post("reply");
    expect(spy).toHaveBeenCalledWith("reply", "*");
    const post = handle.current!.post;
    view.unmount();
    spy.mockClear();
    post("after unmount");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("SandboxFrame navigation lock", () => {
  it("replaces the frame with a notice on a second load and drops the bridge", () => {
    const onStopped = vi.fn();
    const onMessage = vi.fn();
    const handle = createRef<SandboxFrameHandle>();
    renderFrame({ onStopped, onMessage, handleRef: handle });
    const frame = frameOf();
    const target = frame.contentWindow!;
    const spy = vi.spyOn(target, "postMessage");
    fireEvent.load(frame);
    expect(onStopped).not.toHaveBeenCalled();
    fireEvent.load(frame);
    expect(onStopped).toHaveBeenCalledOnce();
    expect(screen.queryByTitle("App")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("This page left its document and was stopped");
    spy.mockClear();
    handle.current!.post("nothing");
    messageFrom(target, "late");
    expect(spy).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("uses the caller's notice text, and a new key opens the document again", () => {
    const view = render(<SandboxFrame key="one" {...base} stoppedLabel="Closed" />);
    fireEvent.load(frameOf());
    fireEvent.load(frameOf());
    expect(screen.getByRole("status").textContent).toBe("Closed");
    view.rerender(<SandboxFrame key="two" {...base} stoppedLabel="Closed" />);
    expect(frameOf().getAttribute("src")).toBe(base.src);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("SandboxFrame colour scheme", () => {
  it("sets the frame's colour scheme and tells the document when it changes after load", async () => {
    renderFrame();
    const frame = frameOf();
    const spy = vi.spyOn(frame.contentWindow!, "postMessage");
    expect(frame.style.colorScheme).toBe("light");
    fireEvent.load(frame);
    expect(spy).toHaveBeenLastCalledWith({ type: FRAME_SCHEME_MESSAGE, scheme: "light" }, "*");
    act(() => { document.documentElement.dataset.theme = "dark"; });
    await vi.waitFor(() => expect(spy).toHaveBeenLastCalledWith({ type: FRAME_SCHEME_MESSAGE, scheme: "dark" }, "*"));
    expect(frameOf().style.colorScheme).toBe("dark");
  });
});

describe("SandboxFrame height", () => {
  const heightOf = (view: { container: HTMLElement }) => (view.container.querySelector(".sandbox-frame") as HTMLElement).style.height;

  it("clamps the requested height and defaults to 320", () => {
    const view = renderFrame();
    expect(heightOf(view)).toBe("320px");
    view.rerender(<SandboxFrame {...base} height={5} />);
    expect(heightOf(view)).toBe("80px");
    view.rerender(<SandboxFrame {...base} height={99999} />);
    expect(heightOf(view)).toBe("2000px");
    view.rerender(<SandboxFrame {...base} height={Number.NaN} />);
    expect(heightOf(view)).toBe("320px");
  });

  it("marks a bordered box", () => {
    const view = renderFrame({ bordered: true });
    expect(view.container.querySelector(".sandbox-frame-box")?.hasAttribute("data-bordered")).toBe(true);
  });
});

describe("SandboxFrame full screen", () => {
  it("shows the same box in the top layer without replacing the iframe", () => {
    const { show, hide } = stubPopover();
    const onFullscreenChange = vi.fn();
    const view = renderFrame({ height: 400, label: "Chart", onFullscreenChange });
    const frame = frameOf();
    const box = view.container.querySelector(".sandbox-frame-box")!;
    expect(box.getAttribute("popover")).toBe("manual");
    expect(box.hasAttribute("data-sandbox-frame-fullscreen")).toBe(false);
    view.rerender(<SandboxFrame {...base} height={400} label="Chart" fullscreen onFullscreenChange={onFullscreenChange} />);
    expect(show).toHaveBeenCalledOnce();
    expect(box.hasAttribute("data-sandbox-frame-fullscreen")).toBe(true);
    expect(frameOf()).toBe(frame);
    expect(screen.getByText("Chart")).toBeTruthy();
    expect((view.container.querySelector(".sandbox-frame") as HTMLElement).style.height).toBe("400px");
    view.rerender(<SandboxFrame {...base} height={400} label="Chart" onFullscreenChange={onFullscreenChange} />);
    expect(hide).toHaveBeenCalledOnce();
    expect(frameOf()).toBe(frame);
    expect(screen.queryByText("Chart")).toBeNull();
  });

  it("asks to leave on Escape outside the document, focus outside the box, and the exit button", () => {
    stubPopover();
    const onFullscreenChange = vi.fn();
    renderFrame({ fullscreen: true, label: "Chart", onFullscreenChange });
    const outside = document.body.appendChild(document.createElement("button"));
    fireEvent.keyDown(window, { key: "a" });
    fireEvent.focusIn(frameOf());
    expect(onFullscreenChange).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onFullscreenChange).toHaveBeenCalledTimes(1);
    fireEvent.focusIn(outside);
    expect(onFullscreenChange).toHaveBeenCalledTimes(2);
    const exit = screen.getByRole("button", { name: "Exit full screen" });
    fireEvent.click(exit);
    expect(onFullscreenChange).toHaveBeenCalledTimes(3);
    expect(onFullscreenChange).toHaveBeenLastCalledWith(false);
  });

  it("stays inline where the Popover API is missing", () => {
    const onFullscreenChange = vi.fn();
    const view = renderFrame({ fullscreen: true, label: "Chart", onFullscreenChange });
    const box = view.container.querySelector(".sandbox-frame-box")!;
    expect(box.hasAttribute("popover")).toBe(false);
    expect(box.hasAttribute("data-sandbox-frame-fullscreen")).toBe(false);
    expect(screen.queryByRole("button", { name: "Exit full screen" })).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onFullscreenChange).not.toHaveBeenCalled();
  });
});

describe("SandboxFrame full-screen zoom", () => {
  const mac = isMacPlatform();
  const percent = () => screen.getByRole("button", { name: "Reset zoom" }).textContent;
  const zoomOf = (view: { container: HTMLElement }) => (view.container.querySelector(".sandbox-frame-zoomed") as HTMLElement).style.getPropertyValue("--sandbox-frame-zoom");
  const chord = (key: string, init: KeyboardEventInit = {}) => ({ key, metaKey: mac, ctrlKey: !mac, ...init });
  /** False when the page took the key (preventDefault). */
  const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(window, chord(key, init));

  it("zooms in quarters between 50 and 200 percent, resets, and leaves the iframe in place", () => {
    stubPopover();
    const view = renderFrame({ fullscreen: true, label: "Chart" });
    const frame = frameOf();
    const zoomIn = screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement;
    const zoomOut = screen.getByRole("button", { name: "Zoom out" }) as HTMLButtonElement;
    expect(percent()).toBe("100%");
    expect(zoomOf(view)).toBe("");
    fireEvent.click(zoomIn);
    expect(percent()).toBe("125%");
    expect(zoomOf(view)).toBe("1.25");
    for (let i = 0; i < 5; i += 1) fireEvent.click(zoomIn);
    expect(percent()).toBe("200%");
    expect(zoomIn.disabled).toBe(true);
    expect(zoomOut.disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
    expect(percent()).toBe("100%");
    expect(zoomOf(view)).toBe("");
    for (let i = 0; i < 5; i += 1) fireEvent.click(zoomOut);
    expect(percent()).toBe("50%");
    expect(zoomOut.disabled).toBe(true);
    expect(zoomOf(view)).toBe("0.5");
    expect(frameOf()).toBe(frame);
    expect(frame.parentElement?.className).toBe("sandbox-frame-zoomed");
  });

  it("has no zoom outside full screen, and starts over at 100 percent after leaving it", () => {
    stubPopover();
    const view = renderFrame({ label: "Chart" });
    expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
    view.rerender(<SandboxFrame {...base} label="Chart" fullscreen />);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(percent()).toBe("125%");
    view.rerender(<SandboxFrame {...base} label="Chart" />);
    expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
    expect(zoomOf(view)).toBe("");
    view.rerender(<SandboxFrame {...base} label="Chart" fullscreen />);
    expect(percent()).toBe("100%");
  });

  it("zooms on Cmd/Ctrl with +, =, - and 0 while full screen is open, and takes the key from the app menu", () => {
    stubPopover();
    const view = renderFrame({ fullscreen: true, label: "Chart" });
    expect(press("=")).toBe(false);
    expect(percent()).toBe("125%");
    expect(press("+", { shiftKey: true })).toBe(false);
    expect(press("+")).toBe(false);
    expect(percent()).toBe("175%");
    expect(press("-")).toBe(false);
    expect(percent()).toBe("150%");
    expect(press("0")).toBe(false);
    expect(percent()).toBe("100%");
    expect(zoomOf(view)).toBe("");
  });

  it("leaves other chords alone", () => {
    stubPopover();
    renderFrame({ fullscreen: true, label: "Chart" });
    expect(press("=", { metaKey: false, ctrlKey: false })).toBe(true);
    expect(press("=", { metaKey: true, ctrlKey: true })).toBe(true);
    expect(press("=", { altKey: true })).toBe(true);
    expect(press("-", { shiftKey: true })).toBe(true);
    expect(press("0", { shiftKey: true })).toBe(true);
    expect(percent()).toBe("100%");
  });

  it("leaves the keys to the workbench when full screen is closed", () => {
    stubPopover();
    const view = renderFrame({ label: "Chart" });
    expect(press("=")).toBe(true);
    view.rerender(<SandboxFrame {...base} label="Chart" fullscreen />);
    expect(press("=")).toBe(false);
    view.rerender(<SandboxFrame {...base} label="Chart" />);
    expect(press("=")).toBe(true);
  });

  describe("from the document", () => {
    const keydown = (key: string, code: string, init: Record<string, unknown> = {}) => ({ type: FRAME_KEYDOWN_MESSAGE, key, code, metaKey: mac, ctrlKey: !mac, shiftKey: false, altKey: false, ...init });
    const activate = (live: boolean) => Object.defineProperty(navigator, "userActivation", { configurable: true, value: { isActive: live } });
    const named = (post: { mock: { calls: unknown[][] } }) => post.mock.calls
      .filter(([message]) => (message as { type?: string }).type === FRAME_KEYS_MESSAGE)
      .map(([message]) => (message as { chords: { key: string; shiftKey: boolean }[] }).chords.map((item) => `${item.shiftKey ? "shift+" : ""}${item.key}`));

    afterEach(() => { delete (navigator as { userActivation?: unknown }).userActivation; });

    function loaded(props: Partial<SandboxFrameProps>) {
      stubPopover();
      const view = renderFrame(props);
      const frame = frameOf();
      const post = vi.spyOn(frame.contentWindow!, "postMessage");
      fireEvent.load(frame);
      return { view, frame, post };
    }

    it("asks the document to pass on the zoom chords only while full screen is open", () => {
      const { view, post } = loaded({ label: "Chart" });
      expect(named(post)).toEqual([]);
      view.rerender(<SandboxFrame {...base} label="Chart" fullscreen />);
      expect(named(post)).toEqual([["=", "+", "shift++", "-", "0"]]);
      view.rerender(<SandboxFrame {...base} label="Chart" />);
      expect(named(post)).toHaveLength(2);
      expect(named(post)[1]).toEqual([]);
    });

    it("zooms for a key the focused document passes on while the click is live", () => {
      const { frame } = loaded({ fullscreen: true, label: "Chart" });
      activate(true);
      frame.focus();
      messageFrom(frame.contentWindow, keydown("=", "Equal"));
      expect(percent()).toBe("125%");
      messageFrom(frame.contentWindow, keydown("-", "Minus"));
      messageFrom(frame.contentWindow, keydown("-", "Minus"));
      expect(percent()).toBe("75%");
      messageFrom(frame.contentWindow, keydown("0", "Digit0"));
      expect(percent()).toBe("100%");
    });

    it("ignores a document that has no focus, no live click, another key or no full screen", () => {
      const { view, frame } = loaded({ fullscreen: true, label: "Chart" });
      activate(true);
      messageFrom(frame.contentWindow, keydown("=", "Equal"));
      frame.focus();
      activate(false);
      messageFrom(frame.contentWindow, keydown("=", "Equal"));
      activate(true);
      messageFrom(window, keydown("=", "Equal"));
      messageFrom(frame.contentWindow, keydown("=", "Equal", { metaKey: false, ctrlKey: false }));
      messageFrom(frame.contentWindow, keydown("q", "KeyQ"));
      expect(percent()).toBe("100%");
      view.rerender(<SandboxFrame {...base} label="Chart" />);
      messageFrom(frame.contentWindow, keydown("=", "Equal"));
      view.rerender(<SandboxFrame {...base} label="Chart" fullscreen />);
      expect(percent()).toBe("100%");
    });
  });
});

describe("SandboxFrame measuring and handle", () => {
  it("reports the box width from a ResizeObserver", () => {
    let notify: ((entries: unknown[]) => void) | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class { constructor(callback: (entries: unknown[]) => void) { notify = callback; } observe() {} disconnect = disconnect; });
    const onWidth = vi.fn();
    const view = renderFrame({ onWidth });
    act(() => { notify?.([{ contentRect: { width: 412.4 } }]); });
    expect(onWidth).toHaveBeenLastCalledWith(412);
    view.unmount();
    expect(disconnect).toHaveBeenCalled();
  });

  it("measures once where there is no ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const onWidth = vi.fn();
    renderFrame({ onWidth });
    expect(onWidth).toHaveBeenCalledWith(0);
  });

  it("answers width and size from the elements", () => {
    const handle = createRef<SandboxFrameHandle>();
    const view = renderFrame({ handleRef: handle });
    expect(handle.current!.width()).toBe(0);
    vi.spyOn(view.container.querySelector(".sandbox-frame-box")!, "getBoundingClientRect").mockReturnValue({ width: 300.4 } as DOMRect);
    vi.spyOn(frameOf(), "getBoundingClientRect").mockReturnValue({ width: 300.4, height: 199.6 } as DOMRect);
    expect(handle.current!.width()).toBe(300);
    expect(handle.current!.size()).toEqual({ width: 300, height: 200 });
  });

  it("allows a link only while the frame has focus and the activation is live", () => {
    const handle = createRef<SandboxFrameHandle>();
    renderFrame({ handleRef: handle });
    const activation = { isActive: true };
    vi.stubGlobal("navigator", { userActivation: activation });
    expect(handle.current!.hasUserActivation()).toBe(false);
    frameOf().focus();
    expect(document.activeElement).toBe(frameOf());
    expect(handle.current!.hasUserActivation()).toBe(true);
    activation.isActive = false;
    expect(handle.current!.hasUserActivation()).toBe(false);
    vi.stubGlobal("navigator", {});
    expect(handle.current!.hasUserActivation()).toBe(false);
  });
});

describe("SandboxFrame app shortcuts", () => {
  const mac = isMacPlatform();
  const press = (key: string, code: string, init: Record<string, unknown> = {}) => ({ type: FRAME_KEYDOWN_MESSAGE, key, code, metaKey: mac, ctrlKey: !mac, ...init });
  const chordOf = (key: string, init: Record<string, unknown> = {}) => ({ key, metaKey: mac, ctrlKey: !mac, shiftKey: false, altKey: false, ...init });

  function appWithFrame(props: Partial<SandboxFrameProps> = {}) {
    const ran = { view: vi.fn(), draft: vi.fn(), settle: vi.fn() };
    const registry = new ExtensionRegistry();
    registry.activate({ id: "test", name: "Test", activate(context) {
      context.registerCommand({ id: "view.open", label: "Open the view", group: "Test", access: "read", run: ran.view });
      context.registerCommand({ id: "runtime.new-session", label: "New thread", group: "Test", access: "write", run: ran.draft });
      context.registerCommand({ id: "thread.settle", label: "Settle", group: "Test", access: "write", run: ran.settle });
      context.registerKeybinding({ keys: "mod+k", commandId: "view.open" });
      context.registerKeybinding({ keys: "mod+n", commandId: "runtime.new-session" });
      context.registerKeybinding({ keys: "mod+shift+s", commandId: "thread.settle" });
      context.registerKeybinding({ keys: "escape", commandId: "view.open" });
    } });
    renderHook(() => useAppKeybindings(registry, {} as WorkbenchActions, vi.fn()));
    const workbench = { registry, tools: [], events: [], openFile: () => undefined, applySnapshot: () => undefined, handleHostEvent: () => undefined };
    const view = render(<WorkbenchContext.Provider value={workbench}><SandboxFrame {...base} {...props} /></WorkbenchContext.Provider>);
    const frame = frameOf();
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.load(frame);
    return { ran, registry, frame, post, view };
  }

  const activate = (live: boolean) => Object.defineProperty(navigator, "userActivation", { configurable: true, value: { isActive: live } });

  afterEach(() => { delete (navigator as { userActivation?: unknown }).userActivation; });

  it("names the chords a page may press once the document loaded, and follows later bindings", () => {
    const { registry, post } = appWithFrame();
    const keys = () => post.mock.calls.filter(([message]) => (message as { type?: string }).type === FRAME_KEYS_MESSAGE);
    expect(keys()).toHaveLength(1);
    expect(keys()[0]![0]).toEqual({ type: FRAME_KEYS_MESSAGE, chords: [chordOf("k"), chordOf("n")] });
    act(() => { registry.activate({ id: "later", name: "Later", activate(context) {
      context.registerCommand({ id: "later.open", label: "Later", group: "Test", access: "read", run: () => undefined });
      context.registerKeybinding({ keys: "mod+j", commandId: "later.open" });
    } }); });
    expect(keys()).toHaveLength(2);
    expect(keys()[1]![0]).toEqual({ type: FRAME_KEYS_MESSAGE, chords: [chordOf("k"), chordOf("n"), chordOf("j")] });
  });

  it("replays a chord that only changes the view, from the focused frame while the click is live", () => {
    const onMessage = vi.fn();
    const { ran, frame } = appWithFrame({ onMessage });
    activate(true);
    frame.focus();
    messageFrom(frame.contentWindow, press("k", "KeyK"));
    expect(ran.view).toHaveBeenCalledOnce();
    messageFrom(frame.contentWindow, press("n", "KeyN"));
    expect(ran.draft).toHaveBeenCalledOnce();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("runs nothing a page may not press, whatever the page claims", () => {
    const { ran, frame } = appWithFrame();
    activate(true);
    frame.focus();
    const forged = [
      press("s", "KeyS", { shiftKey: true }),
      press("k", "KeyK", { metaKey: false, ctrlKey: false }),
      press("Escape", "Escape", { metaKey: false, ctrlKey: false }),
      press("q", "KeyQ"),
      { ...press("k", "KeyK"), key: "" },
    ];
    for (const message of forged) messageFrom(frame.contentWindow, message);
    expect(ran.view).not.toHaveBeenCalled();
    expect(ran.settle).not.toHaveBeenCalled();
    expect(ran.draft).not.toHaveBeenCalled();
  });

  it("replays nothing when the frame has no focus, the click is not live or another window speaks", () => {
    const { ran, frame } = appWithFrame();
    activate(true);
    messageFrom(frame.contentWindow, press("k", "KeyK"));
    frame.focus();
    activate(false);
    messageFrom(frame.contentWindow, press("k", "KeyK"));
    activate(true);
    messageFrom(window, press("k", "KeyK"));
    expect(ran.view).not.toHaveBeenCalled();
  });

  it("passes the key on to nobody where the frame sits outside a workbench", () => {
    const onMessage = vi.fn();
    renderFrame({ onMessage });
    const frame = frameOf();
    activate(true);
    frame.focus();
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    messageFrom(frame.contentWindow, press("k", "KeyK"));
    window.removeEventListener("keydown", seen);
    expect(seen).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });
});
