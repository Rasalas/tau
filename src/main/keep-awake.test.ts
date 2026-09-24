import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { KeepAwake, keepAwakeCommand } from "./keep-awake.js";

/** A helper process that only records what happened to it. */
function fakeSpawn() {
  const started: Array<{ command: string; args: string[]; child: EventEmitter & { killed: boolean } }> = [];
  const spawn = (command: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      killed: false,
      kill() { this.killed = true; return true; },
    });
    started.push({ command, args, child });
    return child as unknown as ChildProcess;
  };
  return { started, spawn };
}

const status = (sessionId: string, running: boolean) => ({ type: "agent-status", sessionId, running });

describe("keeping the machine awake", () => {
  it("names each platform's helper, tied to the host's pid", () => {
    expect(keepAwakeCommand("darwin", 42)).toEqual({ command: "caffeinate", args: ["-i", "-s", "-w", "42"] });
    const linux = keepAwakeCommand("linux", 42)!;
    expect(linux.command).toBe("systemd-inhibit");
    expect(linux.args).toContain("--what=idle:sleep");
    expect(linux.args.at(-1)).toContain("kill -0 42");
    const windows = keepAwakeCommand("win32", 42)!;
    expect(windows.command).toBe("powershell.exe");
    expect(windows.args.at(-1)).toContain("SetThreadExecutionState([uint32]2147483649)");
    expect(windows.args.at(-1)).toContain("Get-Process -Id 42");
    expect(keepAwakeCommand("freebsd", 42)).toBeUndefined();
  });

  it("holds the machine from the first running turn until the last one ends", async () => {
    const { started, spawn } = fakeSpawn();
    const awake = new KeepAwake({ platform: "darwin", pid: 7, enabled: async () => true, spawn });

    awake.observe(status("a", true));
    awake.observe(status("b", true));
    await awake.update();
    expect(started).toHaveLength(1);
    expect(started[0]!.args).toEqual(["-i", "-s", "-w", "7"]);

    awake.observe(status("a", false));
    await awake.update();
    expect(started[0]!.child.killed).toBe(false);

    awake.observe(status("b", false));
    await awake.update();
    expect(started[0]!.child.killed).toBe(true);
    expect(awake.active).toBe(false);
  });

  it("does nothing while the setting is off, and follows it when the config changes", async () => {
    const { started, spawn } = fakeSpawn();
    let enabled = false;
    const awake = new KeepAwake({ platform: "linux", pid: 7, enabled: async () => enabled, spawn });
    awake.observe(status("a", true));
    await awake.update();
    expect(started).toHaveLength(0);

    enabled = true;
    awake.observe({ type: "config-changed" });
    await awake.update();
    expect(started).toHaveLength(1);

    enabled = false;
    awake.observe({ type: "config-changed" });
    await awake.update();
    expect(started[0]!.child.killed).toBe(true);
  });

  it("gives up on a helper that is missing or quits, until the config changes", async () => {
    const { started, spawn } = fakeSpawn();
    const awake = new KeepAwake({ platform: "linux", pid: 7, enabled: async () => true, spawn });
    awake.observe(status("a", true));
    await awake.update();
    started[0]!.child.emit("error", new Error("spawn systemd-inhibit ENOENT"));
    expect(awake.active).toBe(false);

    awake.observe(status("b", true));
    awake.observe(status("a", false));
    awake.observe(status("b", false));
    awake.observe(status("c", true));
    await awake.update();
    expect(started).toHaveLength(1);

    awake.observe({ type: "config-changed" });
    await awake.update();
    expect(started).toHaveLength(2);
  });

  it("lets go when the host stops", async () => {
    const { started, spawn } = fakeSpawn();
    const awake = new KeepAwake({ platform: "win32", pid: 7, enabled: async () => true, spawn });
    awake.observe(status("a", true));
    await awake.update();
    awake.dispose();
    expect(started[0]!.child.killed).toBe(true);
    awake.observe(status("b", true));
    await awake.update();
    expect(started).toHaveLength(1);
  });
});
