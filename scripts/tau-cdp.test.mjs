import { describe, expect, it } from "vitest";
import { formatSnapshot, keySpec, parseCli, pidFromPsOutput, resolvePort } from "./tau-cdp.mjs";

describe("parseCli", () => {
  it("splits a leading numeric token as the port", () => {
    expect(parseCli(["9345", "eval", "1+1"])).toEqual({ port: 9345, command: "eval", args: ["1+1"] });
  });

  it("omits the port when the first token is not all digits", () => {
    expect(parseCli(["eval", "1+1"])).toEqual({ port: undefined, command: "eval", args: ["1+1"] });
  });

  it("supports a command with no arguments", () => {
    expect(parseCli(["9345", "snapshot"])).toEqual({ port: 9345, command: "snapshot", args: [] });
  });

  it("throws when no command is given", () => {
    expect(() => parseCli(["9345"])).toThrow(/usage/);
    expect(() => parseCli([])).toThrow(/usage/);
  });
});

describe("resolvePort", () => {
  it("returns an explicit port without touching the instance file", () => {
    const readFile = () => { throw new Error("should not be called"); };
    expect(resolvePort(9345, { instancePath: "/unused", readFile })).toBe(9345);
  });

  it("falls back to the instance file's port", () => {
    const readFile = () => JSON.stringify({ port: 9377 });
    expect(resolvePort(undefined, { instancePath: "/fake/instance.json", readFile })).toBe(9377);
  });

  it("throws a helpful error when the instance file is missing", () => {
    const readFile = () => { throw new Error("ENOENT"); };
    expect(() => resolvePort(undefined, { instancePath: "/fake/instance.json", readFile })).toThrow(/npm run dev:instance/);
  });

  it("throws when the instance file has no port", () => {
    const readFile = () => JSON.stringify({ pid: 123 });
    expect(() => resolvePort(undefined, { instancePath: "/fake/instance.json", readFile })).toThrow(/no "port"/);
  });
});

describe("pidFromPsOutput", () => {
  it("finds the pid on the line naming the port", () => {
    const ps = [
      "  501 /Applications/Some.app/Contents/MacOS/Some --unrelated",
      " 42123 /path/to/node_modules/.bin/electron . --remote-debugging-port=9345",
    ].join("\n");
    expect(pidFromPsOutput(ps, 9345)).toBe(42123);
  });

  it("prefers the shortest matching line when a helper process also carries the flag", () => {
    const ps = [
      " 99000 /path/electron Helper (Renderer) --type=renderer --remote-debugging-port=9345 --extra-long-tail-of-flags",
      " 42123 /path/electron . --remote-debugging-port=9345",
    ].join("\n");
    expect(pidFromPsOutput(ps, 9345)).toBe(42123);
  });

  it("returns undefined when no line matches the port", () => {
    expect(pidFromPsOutput("  1 /sbin/launchd\n", 9345)).toBeUndefined();
  });
});

describe("keySpec", () => {
  it("resolves a known key by name", () => {
    expect(keySpec("Enter")).toMatchObject({ key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  });

  it("resolves a single printable character", () => {
    expect(keySpec("a")).toMatchObject({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65, text: "a" });
  });

  it("throws on an unknown multi-character name", () => {
    expect(() => keySpec("Home")).toThrow(/unknown key/);
  });
});

describe("formatSnapshot", () => {
  it("renders (none) sections when the page has nothing to show", () => {
    const text = formatSnapshot({ headings: [], buttons: [], threadRows: [], toasts: [], composer: null, activePanels: [] });
    expect(text).toContain("Headings: (none)");
    expect(text).toContain("Buttons: (none)");
    expect(text).toContain("Threads: (none)");
    expect(text).toContain("Toasts: (none)");
    expect(text).toContain("Composer: (not mounted)");
    expect(text).toContain("Active panels: (none)");
  });

  it("marks the active thread row and renders composer state", () => {
    const text = formatSnapshot({
      headings: ["What do you want to build?"],
      buttons: ["New thread", "Send"],
      threadRows: [{ title: "Reply with the single word pong.", active: true }, { title: "Older thread", active: false }],
      toasts: [{ level: "error", text: "Something broke" }],
      composer: { value: "Reply with the single word pong.", streaming: false, sendDisabled: false, sendBusy: false },
      activePanels: ["Changes"],
    });
    expect(text).toContain("* Reply with the single word pong.");
    expect(text).toContain("- Older thread");
    expect(text).toContain("[error] Something broke");
    expect(text).toContain('Composer: value="Reply with the single word pong." streaming=false sendDisabled=false sendBusy=false');
    expect(text).toContain("Active panels:\n  - Changes");
  });

  it("caps the output length and marks the truncation", () => {
    const threadRows = Array.from({ length: 500 }, (_, index) => ({ title: `Thread number ${index}`, active: false }));
    const text = formatSnapshot({ headings: [], buttons: [], threadRows, toasts: [], composer: null, activePanels: [] }, { maxLength: 200 });
    expect(text.length).toBeLessThanOrEqual(200 + "\n… (truncated)".length);
    expect(text.endsWith("… (truncated)")).toBe(true);
  });
});
