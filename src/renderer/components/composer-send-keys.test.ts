import { describe, expect, it } from "vitest";
import { composerEnter, sendHint } from "./composer-send-keys";

const enter = (overrides: Partial<Parameters<typeof composerEnter>[0]> = {}) =>
  composerEnter({ shift: false, mod: false, shortcut: "enter", text: "hi", streaming: false, base: "followUp", ...overrides });

describe("composer send keys", () => {
  it("sends on ↵ and breaks the line on ⇧↵ by default", () => {
    expect(enter()).toEqual({});
    expect(enter({ shift: true })).toBe("newline");
  });

  it("needs ⌘ with mod-enter, and with mod-enter-multiline only once the draft has a newline", () => {
    expect(enter({ shortcut: "mod-enter" })).toBe("newline");
    expect(enter({ shortcut: "mod-enter", mod: true })).toEqual({});
    expect(enter({ shortcut: "mod-enter-multiline" })).toEqual({});
    expect(enter({ shortcut: "mod-enter-multiline", text: "a\nb" })).toBe("newline");
    expect(enter({ shortcut: "mod-enter-multiline", text: "a\nb", mod: true })).toEqual({});
  });

  it("gives a running turn the base delivery on the send chord and the other one on the alternate", () => {
    expect(enter({ streaming: true })).toEqual({ delivery: "followUp" });
    expect(enter({ streaming: true, mod: true })).toEqual({ delivery: "steer" });
    expect(enter({ streaming: true, base: "steer" })).toEqual({ delivery: "steer" });
    expect(enter({ streaming: true, base: "steer", mod: true })).toEqual({ delivery: "followUp" });
    expect(enter({ streaming: true, shortcut: "mod-enter", mod: true })).toEqual({ delivery: "followUp" });
    expect(enter({ streaming: true, shortcut: "mod-enter", mod: true, shift: true })).toEqual({ delivery: "steer" });
  });

  it("asks for the alternate send on the alternate chord while no turn runs", () => {
    expect(enter({ mod: true })).toEqual({ delivery: "alternate" });
    expect(enter({ shortcut: "mod-enter", mod: true, shift: true })).toEqual({ delivery: "alternate" });
  });

  it("names the chords in the placeholder", () => {
    expect(sendHint("enter", false, "followUp")).toBe("Direct the agent — $ skills, / commands, @ files, ⇧↵ newline");
    expect(sendHint("enter", true, "followUp")).toBe("Queue after this turn — ↵ queues, ⌘↵ steers now, ⌥↑ dequeues");
    expect(sendHint("mod-enter", true, "steer")).toBe("Steer this turn — ⌘↵ steers now, ⌘⇧↵ queues, ⌥↑ dequeues");
  });

  it("names no chord on a touch keyboard, whose return key writes a newline", () => {
    expect(sendHint("mod-enter", false, "followUp", true)).toBe("Direct the agent");
    expect(sendHint("mod-enter", true, "steer", true)).toBe("Steer this turn");
    expect(enter({ shortcut: "mod-enter" })).toBe("newline");
  });
});
