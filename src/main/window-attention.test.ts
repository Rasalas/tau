import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createWindowAttention, overlayBadgeBitmap, type NativeNotification } from "./window-attention.js";

class FakeNotification extends EventEmitter implements NativeNotification {
  shown = false;
  constructor(readonly options: { title: string; body?: string }) { super(); }
  show(): void { this.shown = true; }
  close(): void { this.emit("close"); }
}

function setup(options: { supported?: boolean; window?: boolean } = {}) {
  const created: FakeNotification[] = [];
  const reveal = vi.fn(() => options.window ?? true);
  const setBadgeCount = vi.fn(() => true);
  const attention = createWindowAttention({
    isSupported: () => options.supported ?? true,
    create: (notification) => { const made = new FakeNotification(notification); created.push(made); return made; },
    reveal,
    setBadgeCount,
  });
  return { attention, created, reveal, setBadgeCount };
}

describe("notifications and the badge, drawn by the window's process", () => {
  it("shows the notification and answers clicked once the window is in front", async () => {
    const { attention, created, reveal } = setup();
    const outcome = attention.notify({ title: "Turn finished", body: "Fix the build", tag: "t1" });
    expect(created[0]?.options).toEqual({ title: "Turn finished", body: "Fix the build" });
    expect(created[0]?.shown).toBe(true);
    created[0]!.emit("click");
    await expect(outcome).resolves.toBe("clicked");
    expect(reveal).toHaveBeenCalledOnce();
  });

  it("answers dismissed for a click when there is no window left to bring forward", async () => {
    const { attention, created } = setup({ window: false });
    const outcome = attention.notify({ title: "Turn finished" });
    created[0]!.emit("click");
    await expect(outcome).resolves.toBe("dismissed");
  });

  it("replaces an older notification with the same tag", async () => {
    const { attention, created } = setup();
    const first = attention.notify({ title: "One", tag: "t1" });
    const second = attention.notify({ title: "Two", tag: "t1" });
    await expect(first).resolves.toBe("dismissed");
    created[1]!.emit("click");
    await expect(second).resolves.toBe("clicked");
  });

  it("keeps notifications with different tags apart", async () => {
    const { attention, created } = setup();
    const first = attention.notify({ title: "One", tag: "t1" });
    void attention.notify({ title: "Two", tag: "t2" });
    created[0]!.emit("click");
    await expect(first).resolves.toBe("clicked");
  });

  it("answers unavailable where the OS has no notifications or refuses one", async () => {
    await expect(setup({ supported: false }).attention.notify({ title: "x" })).resolves.toBe("unavailable");
    const { attention, created } = setup();
    const outcome = attention.notify({ title: "x" });
    created[0]!.emit("failed");
    await expect(outcome).resolves.toBe("unavailable");
  });

  it("sets the count on the app icon", () => {
    const { attention, setBadgeCount } = setup();
    attention.setBadge(3);
    attention.setBadge(0);
    expect(setBadgeCount.mock.calls).toEqual([[3], [0]]);
  });
});

describe("the badge on Windows", () => {
  it("falls back to the taskbar overlay where there is no badge count", () => {
    const setOverlayBadge = vi.fn(() => true);
    const attention = createWindowAttention({
      isSupported: () => true,
      create: () => new FakeNotification({ title: "" }),
      reveal: () => true,
      setBadgeCount: () => false,
      setOverlayBadge,
    });
    attention.setBadge(3);
    attention.setBadge(0);
    expect(setOverlayBadge.mock.calls).toEqual([[3], [0]]);
  });

  it("draws an opaque dot with a transparent corner", () => {
    const bitmap = overlayBadgeBitmap(16);
    expect(bitmap.length).toBe(16 * 16 * 4);
    const pixel = (x: number, y: number) => [...bitmap.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)];
    expect(pixel(8, 8)).toEqual([0x4d, 0x48, 0xe5, 255]);
    expect(pixel(0, 0)).toEqual([0, 0, 0, 0]);
  });
});
