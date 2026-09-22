import { describe, expect, it } from "vitest";
import { decodeBadgeCount, decodeSystemNotification } from "./system-attention.js";

describe("what a client is asked to show", () => {
  it("keeps a notification's title, body and tag, and bounds them", () => {
    expect(decodeSystemNotification("notify", { title: "Done", body: "Fix it", tag: "t1", extra: 1 })).toEqual({ title: "Done", body: "Fix it", tag: "t1" });
    expect(decodeSystemNotification("notify", { title: "x".repeat(500) }).title).toHaveLength(200);
  });

  it("refuses a notification without a title", () => {
    expect(() => decodeSystemNotification("notify", { body: "x" })).toThrow(/title/u);
    expect(() => decodeSystemNotification("notify", "Done")).toThrow(/object/u);
  });

  it("takes a badge count of zero or more whole numbers only", () => {
    expect(decodeBadgeCount("set-badge", 0)).toBe(0);
    expect(decodeBadgeCount("set-badge", 4)).toBe(4);
    expect(() => decodeBadgeCount("set-badge", -1)).toThrow();
    expect(() => decodeBadgeCount("set-badge", 1.5)).toThrow();
    expect(() => decodeBadgeCount("set-badge", "3")).toThrow();
  });
});
