import { describe as group, expect, it } from "vitest";
import { DEFAULT_SETTINGS, badgeCount, describe, presentation, readMode, readSound, type NotificationSettings } from "./present.js";

const settingsWith = (patch: Partial<NotificationSettings>): NotificationSettings => ({ ...DEFAULT_SETTINGS, ...patch });

group("how loud one piece of news is", () => {
  it("follows the mode while the window is in the background", () => {
    expect(presentation(settingsWith({ mode: "off" }), "background")).toEqual({ system: false, sound: false, toast: false });
    expect(presentation(settingsWith({ mode: "notification" }), "background")).toEqual({ system: true, sound: false, toast: false });
    expect(presentation(settingsWith({ mode: "sound" }), "background")).toEqual({ system: false, sound: true, toast: false });
    expect(presentation(settingsWith({ mode: "both" }), "background")).toEqual({ system: true, sound: true, toast: false });
  });

  it("notifies a focused window on another thread, or toasts there instead when asked", () => {
    expect(presentation(settingsWith({ mode: "both" }), "other-thread")).toEqual({ system: true, sound: true, toast: false });
    expect(presentation(settingsWith({ mode: "both", toasts: true }), "other-thread")).toEqual({ system: false, sound: true, toast: true });
    expect(presentation(settingsWith({ mode: "off", toasts: true }), "other-thread")).toEqual({ system: false, sound: false, toast: true });
  });

  it("stays silent about the thread on screen unless asked not to", () => {
    expect(presentation(settingsWith({ mode: "both" }), "on-screen")).toEqual({ system: false, sound: false, toast: false });
    expect(presentation(settingsWith({ mode: "sound", whenFocused: true }), "on-screen")).toEqual({ system: false, sound: true, toast: false });
    expect(presentation(settingsWith({ mode: "both", whenFocused: true, toasts: true }), "on-screen")).toEqual({ system: true, sound: true, toast: false });
  });

  it("badges the count of unseen threads unless everything is off", () => {
    const items = [{ threadId: "a", reason: "completed" as const, at: 1 }, { threadId: "b", reason: "question" as const, at: 2 }];
    expect(badgeCount(settingsWith({ mode: "sound" }), items)).toBe(2);
    expect(badgeCount(settingsWith({ mode: "off" }), items)).toBe(0);
  });

  it("reads unknown stored values as the defaults", () => {
    expect(readMode("loud")).toBe(DEFAULT_SETTINGS.mode);
    expect(readMode("both")).toBe("both");
    expect(readSound(undefined)).toBe("chime");
    expect(readSound("ping")).toBe("ping");
  });

  it("names the thread and what happened, or counts several", () => {
    const title = (item: { threadId: string }) => `Thread ${item.threadId}`;
    expect(describe([{ threadId: "a", reason: "question", at: 1 }], title)).toEqual({ title: "Thread a", body: "Waiting for your answer" });
    const many = ["a", "b", "c", "d"].map((threadId) => ({ threadId, reason: "completed" as const, at: 1 }));
    expect(describe(many, title)).toEqual({ title: "4 threads need you", body: "Thread a, Thread b, Thread c and 1 more" });
  });
});
