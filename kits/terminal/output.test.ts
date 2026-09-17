import { describe, expect, it } from "vitest";
import { unseenOutput } from "./output.js";

describe("unseenOutput", () => {
  it("draws a chunk that follows what was replayed", () => {
    expect(unseenOutput({ id: "t", data: "world", offset: 10 }, 5)).toBe("world");
  });

  it("skips the part of a chunk the replay already covered", () => {
    expect(unseenOutput({ id: "t", data: "hello world", offset: 11 }, 6)).toBe("world");
  });

  it("ignores a chunk that arrived before the replay caught up", () => {
    expect(unseenOutput({ id: "t", data: "hello", offset: 5 }, 5)).toBe("");
    expect(unseenOutput({ id: "t", data: "hel", offset: 3 }, 5)).toBe("");
  });

  it("draws the whole chunk when the replay was empty", () => {
    expect(unseenOutput({ id: "t", data: "first", offset: 5 }, 0)).toBe("first");
  });
});
