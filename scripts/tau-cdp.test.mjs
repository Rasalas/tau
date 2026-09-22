import { describe, expect, it } from "vitest";
import { formatSnapshot, instanceHostPid, keySpec, parseChord, parseCli, pidFromPsOutput, resolvePort, stopProcess } from "./tau-cdp.mjs";

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

describe("instanceHostPid", () => {
  it("prefers the host descriptor, which a restart rewrites", () => {
    const readFile = () => JSON.stringify({ pid: 99, url: "ws://127.0.0.1:1" });
    expect(instanceHostPid({ hostPid: 4242, userData: "/instance" }, { readFile })).toBe(99);
  });

  it("falls back to the pid the instance file recorded", () => {
    const readFile = () => { throw new Error("no such file"); };
    expect(instanceHostPid({ hostPid: 4242, userData: "/instance" }, { readFile })).toBe(4242);
  });

  it("names no pid when the instance has no host", () => {
    const readFile = () => { throw new Error("no such file"); };
    expect(instanceHostPid({ userData: "/instance" }, { readFile })).toBeUndefined();
    expect(instanceHostPid(undefined)).toBeUndefined();
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

describe("parseChord", () => {
  it("resolves mod to meta on macOS", () => {
    const chord = parseChord("mod+k", { platform: "darwin" });
    expect(chord.modifiers).toBe(4);
    expect(chord.key).toMatchObject({ key: "k", code: "KeyK" });
  });

  it("resolves mod to ctrl off macOS", () => {
    const chord = parseChord("mod+k", { platform: "linux" });
    expect(chord.modifiers).toBe(2);
  });

  it("combines mod with other modifiers, order independent", () => {
    const chord = parseChord("mod+shift+d", { platform: "darwin" });
    expect(chord.modifiers).toBe(4 | 8);
    expect(chord.key).toMatchObject({ key: "d", code: "KeyD" });
  });

  it("accepts a named key in a chord", () => {
    const chord = parseChord("mod+enter", { platform: "darwin" });
    expect(chord.key).toMatchObject({ key: "Enter", code: "Enter" });
  });

  it("returns undefined for a bare key (not a chord)", () => {
    expect(parseChord("d")).toBeUndefined();
    expect(parseChord("Enter")).toBeUndefined();
  });

  it("throws on an unknown modifier", () => {
    expect(() => parseChord("hyper+d")).toThrow(/unknown modifier/);
  });
});

describe("stopProcess", () => {
  it("does not escalate when SIGTERM alone ends the process", async () => {
    const calls = [];
    let alive = true;
    const result = await stopProcess(4242, {
      kill: (pid, signal) => { calls.push([pid, signal]); if (signal === "SIGTERM") alive = false; },
      isAlive: () => alive,
      wait: async () => {},
    });
    expect(calls).toEqual([[4242, "SIGTERM"]]);
    expect(result).toEqual({ pid: 4242, escalated: false });
  });

  it("escalates to SIGKILL when the process outlives the grace period", async () => {
    const calls = [];
    const result = await stopProcess(4242, {
      kill: (pid, signal) => calls.push([pid, signal]),
      isAlive: () => true,
      wait: async () => {},
      graceMs: 10,
      pollMs: 1,
    });
    expect(calls).toEqual([[4242, "SIGTERM"], [4242, "SIGKILL"]]);
    expect(result).toEqual({ pid: 4242, escalated: true });
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
