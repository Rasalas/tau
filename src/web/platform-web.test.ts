// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../workbench/client-storage";
import { createWebPlatform, webAttention } from "./platform-web";

const ports = () => ({ storage: createMemoryStorage(), openInEditor: () => undefined, hasLocalFiles: () => true });

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("what a browser tab can offer the workbench", () => {
  it("writes to the page's own clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await createWebPlatform(ports()).clipboard.writeText("copied");
    expect(writeText).toHaveBeenCalledWith("copied");
  });

  it("says so when the browser will not let it copy, instead of copying nothing", async () => {
    vi.stubGlobal("navigator", {});
    await expect(createWebPlatform(ports()).clipboard.writeText("copied")).rejects.toThrow(/clipboard/u);
  });

  it("has no editor and no image clipboard, even on a host that is this machine", () => {
    const platform = createWebPlatform(ports());
    expect(platform.files).toBeUndefined();
    expect(platform.clipboard.writeImage).toBeUndefined();
  });

  it("stores through the client storage it was booted with", () => {
    const storage = createMemoryStorage();
    const platform = createWebPlatform({ ...ports(), storage });
    platform.storage.set("k", "v");
    expect(storage.get("k")).toBe("v");
  });

  it("draws the user's attention with the page's Notification API", async () => {
    const shown: Array<{ title: string; options: NotificationOptions; onclick?: () => void; close(): void }> = [];
    class FakeNotification {
      static permission = "granted";
      static requestPermission = vi.fn();
      onclick?: () => void;
      constructor(readonly title: string, readonly options: NotificationOptions) { shown.push(this); }
      close(): void {}
    }
    vi.stubGlobal("Notification", FakeNotification);
    const focus = vi.spyOn(window, "focus").mockImplementation(() => undefined);
    const outcome = webAttention().notify({ title: "Turn finished", body: "Fix the build", tag: "t1" });
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    expect(shown[0]).toMatchObject({ title: "Turn finished", options: { body: "Fix the build", tag: "t1", silent: true } });
    shown[0]!.onclick?.();
    await expect(outcome).resolves.toBe("clicked");
    expect(focus).toHaveBeenCalled();
  });

  it("asks for the permission once and shows nothing when it is refused", async () => {
    const requestPermission = vi.fn(async () => { FakeNotification.permission = "denied"; return "denied"; });
    class FakeNotification { static permission = "default"; static requestPermission = requestPermission; }
    vi.stubGlobal("Notification", FakeNotification);
    await expect(webAttention().notify({ title: "x" })).resolves.toBe("unavailable");
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it("answers unavailable in a browser without notifications", async () => {
    vi.stubGlobal("Notification", undefined);
    await expect(webAttention().notify({ title: "x" })).resolves.toBe("unavailable");
    await expect(webAttention().requestPermission?.()).resolves.toBe(false);
  });

  it("draws the count into the tab's icon and the app badge, and clears both", () => {
    const setAppBadge = vi.fn(async () => undefined);
    const clearAppBadge = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { setAppBadge, clearAppBadge });
    const drawn: string[] = [];
    const context = new Proxy({}, { get: (_target, name) => name === "fillText" ? (text: string) => drawn.push(text) : () => undefined, set: () => true });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,AAAA");
    const attention = webAttention();
    attention.setBadge(12);
    expect(drawn).toEqual(["9+"]);
    expect(document.head.querySelector<HTMLLinkElement>("link[data-tau-badge]")?.href).toBe("data:image/png;base64,AAAA");
    expect(setAppBadge).toHaveBeenCalledWith(12);
    attention.setBadge(0);
    expect(clearAppBadge).toHaveBeenCalledOnce();
    expect(document.head.querySelector("link[data-tau-badge]")).toBeNull();
  });

  it("draws the count over Tau's favicon and gives the page its icons back when cleared", () => {
    vi.stubGlobal("navigator", {});
    const own = Object.assign(document.createElement("link"), { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" });
    document.head.append(own);
    const calls: string[] = [];
    const context = new Proxy({}, { get: (_target, name) => typeof name === "string" && name !== "then" ? (...args: unknown[]) => calls.push(`${name}:${args.length}`) : undefined, set: () => true });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,BBBB");
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(32);
    const attention = webAttention();
    attention.setBadge(3);
    expect(calls).toContain("drawImage:5");
    expect(own.isConnected).toBe(false);
    expect(document.head.querySelector<HTMLLinkElement>("link[data-tau-badge]")?.href).toBe("data:image/png;base64,BBBB");
    attention.setBadge(0);
    expect(own.isConnected).toBe(true);
    expect(document.head.querySelector("link[data-tau-badge]")).toBeNull();
    own.remove();
  });
});
