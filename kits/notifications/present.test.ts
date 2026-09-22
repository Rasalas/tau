import { describe as group, expect, it } from "vitest";
import { DEFAULT_SETTINGS, badgeCount, describe, presentation, readMode, readSound, type NotificationSettings } from "./present.js";

const with_ = (patch: Partial<NotificationSettings>): NotificationSettings => ({ ...DEFAULT_SETTINGS, ...patch });

group("how loud one piece of news is", () => {
  it("follows the mode while the window is in the background", () => {
    expect(presentation(with_({ mode: "off" }), false)).toEqual({ system: false, sound: false, toast: false });
    expect(presentation(with_({ mode: "notification" }), false)).toEqual({ system: true, sound: false, toast: false });
    expect(presentation(with_({ mode: "sound" }), false)).toEqual({ system: false, sound: true, toast: false });
    expect(presentation(with_({ mode: "both" }), false)).toEqual({ system: true, sound: true, toast: false });
  });

  it("is silent in a focused window unless the user opted in", () => {
    expect(presentation(with_({ mode: "both" }), true)).toEqual({ system: false, sound: false, toast: false });
    expect(presentation(with_({ mode: "both", toasts: true }), true)).toEqual({ system: false, sound: true, toast: true });
    expect(presentation(with_({ mode: "off", toasts: true }), true)).toEqual({ system: false, sound: false, toast: true });
    expect(presentation(with_({ mode: "notification", whenFocused: true }), true)).toEqual({ system: true, sound: false, toast: false });
  });

  it("badges the count of unseen threads unless everything is off", () => {
    const items = [{ threadId: "a", reason: "completed" as const, at: 1 }, { threadId: "b", reason: "question" as const, at: 2 }];
    expect(badgeCount(with_({ mode: "sound" }), items)).toBe(2);
    expect(badgeCount(with_({ mode: "off" }), items)).toBe(0);
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
