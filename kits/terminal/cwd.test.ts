import { describe, expect, it } from "vitest";
import { CwdTracker, osc7Path } from "./cwd.js";

const report = (url: string, end = "\u0007") => `\u001b]7;${url}${end}`;

describe("osc7Path", () => {
  it("reads a local file URL, decoded, without a trailing slash", () => {
    expect(osc7Path("file://mac.local/Users/me/My%20Project/", "mac.local", "darwin")).toBe("/Users/me/My Project");
    expect(osc7Path("file:///tmp", "mac.local", "darwin")).toBe("/tmp");
    expect(osc7Path("file://localhost/", "mac.local", "darwin")).toBe("/");
    expect(osc7Path("file://mac/Users/me", "mac.local", "darwin")).toBe("/Users/me");
  });

  it("refuses another machine's path and anything that is no file URL", () => {
    expect(osc7Path("file://build-server/home/me", "mac.local", "darwin")).toBeUndefined();
    expect(osc7Path("https://mac.local/Users", "mac.local", "darwin")).toBeUndefined();
    expect(osc7Path("file:///bad%E0%A4%A", "mac.local", "darwin")).toBeUndefined();
  });

  it("turns a Windows drive path into one the platform reads", () => {
    expect(osc7Path("file:///C:/Users/me", "pc", "win32")).toBe("C:\\Users\\me");
    expect(osc7Path("file:///home/me", "pc", "win32")).toBeUndefined();
  });
});

describe("CwdTracker", () => {
  it("answers with the newest report of a chunk, either terminator", () => {
    const tracker = new CwdTracker("mac.local", "darwin");
    expect(tracker.feed("plain output")).toBeUndefined();
    expect(tracker.feed(`${report("file:///a")}$ ${report("file:///b", "\u001b\\")}$ `)).toBe("/b");
  });

  it("finishes a report the next chunk completes, wherever it was cut", () => {
    const whole = `out${report("file:///Users/me/work")}$ `;
    for (let cut = 1; cut < whole.length; cut += 1) {
      const tracker = new CwdTracker("mac.local", "darwin");
      const first = tracker.feed(whole.slice(0, cut));
      const second = tracker.feed(whole.slice(cut));
      expect(first ?? second).toBe("/Users/me/work");
    }
  });

  it("keeps a report cut inside its string terminator", () => {
    const tracker = new CwdTracker("mac.local", "darwin");
    expect(tracker.feed("\u001b]7;file:///x\u001b")).toBeUndefined();
    expect(tracker.feed("\\$ ")).toBe("/x");
  });

  it("skips a report from another machine and lets an unfinished one go when it grows too long", () => {
    const tracker = new CwdTracker("mac.local", "darwin");
    expect(tracker.feed(report("file://far/home/me"))).toBeUndefined();
    expect(tracker.feed(`\u001b]7;file:///${"x".repeat(5000)}`)).toBeUndefined();
    expect(tracker.feed("\u0007")).toBeUndefined();
  });
});
