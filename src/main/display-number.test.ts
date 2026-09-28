import { describe, expect, it } from "vitest";
import { abstractX11Displays, displayInUse, firstFreeDisplay, type DisplayProbe } from "./display-number.js";

function probe(input: { files?: Record<string, string>; alive?: number[]; listening?: number[]; processes?: { pid: number; args: string[] }[] } = {}): DisplayProbe {
  const files = input.files ?? {};
  return {
    exists: (path) => path in files,
    readFile: (path) => files[path],
    alive: (pid) => (input.alive ?? []).includes(pid),
    listening: new Set(input.listening ?? []),
    processes: input.processes ?? [],
  };
}

describe("a free display", () => {
  it("is one with no lock, no socket, no abstract socket and no X server on it", () => {
    expect(displayInUse(99, probe())).toBeUndefined();
    expect(displayInUse(99, probe({ files: { "/tmp/.X99-lock": "      4242\n" }, alive: [4242] }))).toBe("/tmp/.X99-lock (pid 4242, running)");
    expect(displayInUse(99, probe({ files: { "/tmp/.X99-lock": "4242\n" } }))).toBe("/tmp/.X99-lock (pid 4242, not running)");
    expect(displayInUse(99, probe({ files: { "/tmp/.X99-lock": "" } }))).toBe("/tmp/.X99-lock");
    expect(displayInUse(99, probe({ files: { "/tmp/.X11-unix/X99": "" } }))).toBe("/tmp/.X11-unix/X99");
    expect(displayInUse(99, probe({ listening: [99] }))).toBe("abstract socket @/tmp/.X11-unix/X99");
    // Its lock and socket gone, e.g. /tmp cleaned under it: the process still has the display.
    expect(displayInUse(99, probe({ processes: [{ pid: 7, args: ["/usr/bin/Xvfb", ":99", "-nolisten", "tcp"] }] }))).toBe("X server pid 7 (/usr/bin/Xvfb :99 -nolisten tcp)");
    expect(displayInUse(99, probe({ processes: [{ pid: 8, args: ["/usr/bin/Xorg", "vt1", ":99"] }] }))).toMatch(/^X server pid 8/u);
    // Other displays, and programs that merely mention one, do not count.
    expect(displayInUse(99, probe({ processes: [{ pid: 7, args: ["Xvfb", ":100"] }, { pid: 9, args: ["xdotool", ":99"] }] }))).toBeUndefined();
  });

  it("is the first number nothing claims, with the reason for each skipped one", () => {
    const machine = probe({ files: { "/tmp/.X99-lock": "12\n", "/tmp/.X11-unix/X100": "" }, alive: [12], listening: [101] });
    expect(firstFreeDisplay((number) => displayInUse(number, machine))).toEqual({
      number: 102,
      skipped: [
        { number: 99, reason: "/tmp/.X99-lock (pid 12, running)" },
        { number: 100, reason: "/tmp/.X11-unix/X100" },
        { number: 101, reason: "abstract socket @/tmp/.X11-unix/X101" },
      ],
    });
    expect(firstFreeDisplay((number) => number < 101)).toMatchObject({ number: 101 });
    expect(firstFreeDisplay(() => true, 99, 100)).toEqual({ skipped: [{ number: 99, reason: "in use" }, { number: 100, reason: "in use" }] });
  });

  it("counts a display another network-namespace peer listens on as taken", () => {
    const table = [
      "Num       RefCount Protocol Flags    Type St Inode Path",
      "0000000000000000: 00000002 00000000 00010000 0001 01 1234 @/tmp/.X11-unix/X99",
      "0000000000000000: 00000003 00000000 00000000 0001 03 1256 @/tmp/.X11-unix/X0",
      "0000000000000000: 00000002 00000000 00010000 0001 01 1235 /tmp/.X11-unix/X101",
    ].join("\n");
    expect([...abstractX11Displays(table)].sort()).toEqual([0, 99]);
  });
});
