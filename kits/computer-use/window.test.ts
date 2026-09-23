import { describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  WebContentsView: vi.fn(),
  app: { getFileIcon: vi.fn() },
  session: { fromPartition: vi.fn() },
  shell: { openExternal: vi.fn() },
  systemPreferences: { getMediaAccessStatus: vi.fn(() => "denied") },
}));
vi.mock("electron", () => electron);

const { bundleOf, default: activate, screenAccess, windowSourceId } = await import("./window.js");

const half = () => activate({ id: "tau.computer-use", invokeHost: async () => undefined, log: () => undefined });

describe("Computer Use's window half", () => {
  it("reads the Screen Recording permission on macOS only, and never asks for it", () => {
    expect(screenAccess("darwin", () => "granted")).toBe("granted");
    expect(screenAccess("darwin", () => "not-determined")).toBe("not-determined");
    expect(screenAccess("darwin", () => "something new")).toBe("unavailable");
    expect(screenAccess("linux", () => "granted")).toBe("unavailable");
  });

  it("names one window as a capture source and refuses anything else", () => {
    expect(windowSourceId(33962)).toBe("window:33962:0");
    for (const bad of [0, -1, 1.5, "33962", undefined, Number.NaN]) expect(() => windowSourceId(bad)).toThrow();
  });

  it("finds the app bundle of an executable", () => {
    expect(bundleOf("/Applications/Mail.app/Contents/MacOS/Mail")).toBe("/Applications/Mail.app");
    expect(bundleOf("/usr/bin/python3")).toBeUndefined();
  });

  it("starts no capture without the permission and answers why", async () => {
    const window = half();
    const answer = await window.handle("live-start", { windowId: 7 });

    expect(answer).not.toBe("granted");
    expect(electron.WebContentsView).not.toHaveBeenCalled();
    expect(await window.handle("live-frame", { windowId: 7 })).toEqual({ ended: true });
    await expect(window.handle("live-start", { windowId: "window:1:0" })).rejects.toThrow();
    await expect(window.handle("screenshot")).rejects.toThrow(/no command/u);
  });
});
