import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceManager, validateSettings } from "./manager.js";
import { DEFAULT_SETTINGS, TOOLS, type DeviceSettings } from "./protocol.js";
import { quote, type Run } from "./process.js";
import { Toolchain } from "./toolchain.js";
import { deviceTools } from "./host.js";
const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "tau-devices-test-")); directories.push(path); return path; }
const settings = (): DeviceSettings => structuredClone(DEFAULT_SETTINGS);

describe("device host configuration", () => {
  it("rejects SSH options and relative tool directories before executing a process", () => {
    for (const ssh of ["-oProxyCommand=bad", "mac;bad", "mac\nother", "mac $(bad)"]) expect(() => validateSettings({ ...settings(), hosts: [...settings().hosts, { id: "remote", name: "Mac", ssh, remoteDirectory: "/tmp/tools" }] })).toThrow();
    expect(() => validateSettings({ ...settings(), hosts: [...settings().hosts, { id: "remote", name: "Mac", ssh: "user@mac", remoteDirectory: "~/tools" }] })).toThrow("absolute");
    expect(() => validateSettings({ ...settings(), hosts: [{ id: "remote", name: "Mac", ssh: "mac", remoteDirectory: "/tmp/tools" }] })).toThrow("local");
  });
  it("keeps SSH remote command arguments intact", () => {
    expect(quote("a'$(touch /tmp/no) b")).toBe("'a'\"'\"'$(touch /tmp/no) b'");
  });
  it("persists explicit consent and revokes it for already registered agent tools", async () => {
    const path = await directory(), manager = new DeviceManager(path);
    const tools = deviceTools(manager);
    await expect(tools[0].execute("1", { hostId: "local" }, undefined, undefined, undefined!)).rejects.toThrow("off");
    await manager.configure({ ...settings(), agentControl: true });
    await expect(manager.consent()).resolves.toBeUndefined();
    const reopened = new DeviceManager(path);
    await expect(reopened.consent()).resolves.toBeUndefined();
    await manager.configure(settings());
    await expect(tools[1].execute("2", { hostId: "local", deviceId: "phone" }, undefined, undefined, undefined!)).rejects.toThrow("off");
    manager.dispose(); reopened.dispose();
  });
});

describe("private device tool installation", () => {
  it("never regards an extracted entry without the completion marker as installed", async () => {
    const path = await directory(), tools = new Toolchain(path);
    const entry = tools.entry("hub");
    await mkdir(join(entry, ".."), { recursive: true }); await writeFile(entry, "entry");
    expect(await tools.installed("hub")).toBe(false);
    await writeFile(join(tools.root("hub"), ".complete"), TOOLS.hub.version);
    expect(await tools.installed("hub")).toBe(true);
  });
  it("publishes only a completed install and deduplicates simultaneous requests", async () => {
    const path = await directory();
    const execute: Run = vi.fn(async (_command, args) => {
      const staging = args[args.indexOf("--prefix") + 1];
      const entry = join(staging, "node_modules", TOOLS.agent.package, TOOLS.agent.entry);
      await mkdir(join(entry, ".."), { recursive: true }); await writeFile(entry, "entry");
      return { stdout: "", stderr: "" };
    });
    const tools = new Toolchain(path, execute);
    await Promise.all([tools.install("agent", settings()), tools.install("agent", settings())]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await tools.installed("agent")).toBe(true);
    expect(vi.mocked(execute).mock.calls[0][1]).toContain(`agent-device@${TOOLS.agent.version}`);
    expect(vi.mocked(execute).mock.calls[0][1]).not.toContain("-g");
  });
  it("does not publish a failed installation", async () => {
    const tools = new Toolchain(await directory(), async () => { throw new Error("registry unavailable"); });
    await expect(tools.install("hub", settings())).rejects.toThrow("registry unavailable");
    expect(await tools.installed("hub")).toBe(false);
  });
  it("quotes remote installation paths and refuses invalid tool names", async () => {
    const execute: Run = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const manager = new DeviceManager(await directory(), execute);
    await manager.configure({ ...settings(), hosts: [...settings().hosts, { id: "mac", name: "Mac", ssh: "device-mac", remoteDirectory: "/tmp/Tau's tools" }] });
    await manager.install("agent", "mac");
    expect(vi.mocked(execute).mock.calls[0][0]).toBe("ssh");
    expect(vi.mocked(execute).mock.calls[0][1]).toContain("BatchMode=yes");
    expect(vi.mocked(execute).mock.calls[0][1].at(-1)).toContain("agent-device@0.21.12");
    await expect(manager.install("invalid" as "hub", "mac")).rejects.toThrow("Unknown");
    manager.dispose();
  });
});


describe("device operations through the real loopback transport", () => {
  async function fixture() {
    const path = await directory();
    const execute: Run = vi.fn(async (command, args) => ({ stdout: command === "emulator" ? "" : args.includes("SIMULATOR_MAINSCREEN_SCALE") ? "3" : "native output", stderr: "" }));
    const manager = new DeviceManager(path, execute);
    await manager.configure({ ...settings(), node: process.execPath });
    const hubEntry = manager.tools.entry("hub");
    await mkdir(join(hubEntry, ".."), { recursive: true });
    await copyFile(new URL("./fixtures/fake-hub.mjs", import.meta.url), hubEntry);
    await writeFile(join(manager.tools.root("hub"), ".complete"), TOOLS.hub.version);
    const agentEntry = manager.tools.entry("agent");
    await mkdir(join(agentEntry, ".."), { recursive: true }); await writeFile(agentEntry, "fixture");
    await writeFile(join(manager.tools.root("agent"), ".complete"), TOOLS.agent.version);
    return { manager, execute };
  }
  it("discovers and captures the explicit device, routes platform settings and rejects unsupported controls", async () => {
    const { manager, execute } = await fixture();
    try {
      const list = await manager.discover("local");
      expect(list.map((entry) => [entry.id, entry.hostId])).toEqual([["ios-phone", "local"], ["android-phone", "local"]]);
      const target = { hostId: "local", deviceId: "ios-phone" };
      expect((await manager.frame(target)).dataUrl).toMatch(/^data:image\/png;base64,/);
      await manager.action({ ...target, action: "appearance", value: "dark" });
      expect(execute).toHaveBeenLastCalledWith("xcrun", ["simctl", "ui", "ios-phone", "appearance", "dark"], { signal: undefined });
      await expect(manager.action({ ...target, action: "location", latitude: 200, longitude: 0 })).rejects.toThrow("latitude");
      await expect(manager.action({ ...target, action: "fold", enabled: true })).rejects.toThrow("Android");
      await manager.action({ ...target, deviceId: "android-phone", action: "fold", enabled: true });
      await manager.action({ ...target, action: "shutdown" });
      await expect(manager.frame(target)).rejects.toThrow("Boot");
      await manager.action({ ...target, action: "boot" });
      expect((await manager.frame(target)).dataUrl).toMatch(/^data:image/);
      await expect(manager.frame({ ...target, deviceId: "missing" })).rejects.toThrow("no longer available");
    } finally { manager.dispose(); }
  });
  it("uses the maintained CLI's exact input commands and checks consent at execution time", async () => {
    const { manager, execute } = await fixture();
    try {
      const target = { hostId: "local", deviceId: "ios-phone" };
      await manager.discover("local");
      await manager.action({ ...target, action: "rotate", value: "landscape-left" });
      const args = vi.mocked(execute).mock.calls.at(-1)![1];
      expect(args.slice(1, 3)).toEqual(["orientation", "landscape-left"]);
      expect(args).toContain("--udid"); expect(args).toContain("ios-phone"); expect(args).toContain("--state-dir");
      await manager.action({ ...target, action: "tap", x: 300, y: 600 });
      expect(vi.mocked(execute).mock.calls.at(-1)![1].slice(1, 4)).toEqual(["click", "100", "200"]);
      await expect(manager.action({ ...target, action: "tap", x: 10, y: 20 }, undefined, true)).rejects.toThrow("off");
    } finally { manager.dispose(); }
  });
});
