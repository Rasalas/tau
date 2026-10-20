import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { DeviceManager, remoteHubCommand, validateSettings } from "./manager.js";
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
      const android = { ...target, deviceId: "android-phone" };
      expect(await manager.foldState(android)).toEqual({ supported: true, posture: "opened", hingeAngle: 180 });
      expect(await manager.action({ ...android, action: "fold", enabled: true })).toEqual({ supported: true, posture: "closed", hingeAngle: 0 });
      expect(await manager.foldState(android)).toEqual({ supported: true, posture: "closed", hingeAngle: 0 });
      expect(await manager.foldState(target)).toEqual({ supported: false, posture: null, hingeAngle: null });
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

describe("device hub lifetime", () => {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const until = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50)); return check(); };
  it("stops the remote hub when the ssh session's stdin closes", async () => {
    const path = await directory();
    await writeFile(join(path, "node"), `#!/bin/sh\necho $$ > "${path}/hub.pid"\nexec sleep 30\n`, { mode: 0o755 });
    const child = spawn("sh", ["-c", remoteHubCommand(["entry's.js", "--port", "1"])], { env: { ...process.env, PATH: `${path}:${process.env.PATH}` }, stdio: ["pipe", "ignore", "ignore"] });
    const exited = new Promise((resolve) => child.on("close", resolve));
    let pid = 0;
    try {
      expect(await until(() => existsSync(join(path, "hub.pid")) && readFileSync(join(path, "hub.pid"), "utf8").trim() !== "")).toBe(true);
      pid = Number(readFileSync(join(path, "hub.pid"), "utf8"));
      expect(alive(pid)).toBe(true);
      child.stdin!.end();
      await exited;
      expect(await until(() => !alive(pid))).toBe(true);
    } finally { child.kill(); if (pid && alive(pid)) process.kill(pid, "SIGKILL"); }
  });
  it("ends the remote session when the hub exits by itself", async () => {
    const path = await directory();
    await writeFile(join(path, "node"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    const child = spawn("sh", ["-c", remoteHubCommand([])], { env: { ...process.env, PATH: `${path}:${process.env.PATH}` }, stdio: ["pipe", "ignore", "ignore"] });
    const code = await new Promise((resolve) => child.on("close", resolve));
    expect(code).toBe(3);
    child.kill();
  });
  it("starts an ssh hub with a piped stdin and the watching remote command", async () => {
    const launched: { command: string; args: string[]; options: { stdio: unknown } }[] = [];
    const launch = ((command: string, args: string[], options: { stdio: unknown }) => {
      launched.push({ command, args, options });
      return Object.assign(new EventEmitter(), { exitCode: 1, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    }) as unknown as typeof spawn;
    const manager = new DeviceManager(await directory(), vi.fn(), fetch, launch);
    await manager.configure({ ...settings(), hosts: [...settings().hosts, { id: "mac", name: "Mac", ssh: "device-mac", remoteDirectory: "/tmp/tools" }] });
    await expect(manager.discover("mac")).rejects.toThrow();
    expect(launched[0].command).toBe("ssh");
    expect(launched[0].options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(launched[0].args).toContain("-T");
    expect(launched[0].args.at(-1)).toMatch(/^sh -c '.*cat <&3.*kill/s);
    manager.dispose();
  });
  it("starts the local hub as an owned process so it ends when Tau is killed", async () => {
    const owned: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const launch = vi.fn() as unknown as typeof spawn;
    const own = (input: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }) => {
      owned.push(input);
      return Object.assign(new EventEmitter(), { exitCode: 1, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }) as unknown as ReturnType<typeof spawn>;
    };
    const manager = new DeviceManager(await directory(), vi.fn(), fetch, launch, own);
    await manager.configure({ ...settings(), node: "/opt/node" });
    vi.spyOn(manager.tools, "installed").mockResolvedValue(true);
    await expect(manager.discover("local")).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
    expect(owned[0]).toMatchObject({ command: "/opt/node", args: expect.arrayContaining(["--port", "--hide-sidebar"]), env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: "1" }) });
    manager.dispose();
  });
  async function running() {
    const path = await directory();
    const manager = new DeviceManager(path, vi.fn(async () => ({ stdout: "", stderr: "" })));
    await manager.configure({ ...settings(), node: process.execPath });
    const hubEntry = manager.tools.entry("hub");
    await mkdir(join(hubEntry, ".."), { recursive: true });
    await copyFile(new URL("./fixtures/fake-hub.mjs", import.meta.url), hubEntry);
    await writeFile(join(manager.tools.root("hub"), ".complete"), TOOLS.hub.version);
    await manager.discover("local");
    const pid = () => (manager as unknown as { hubs: Map<string, { child: { pid: number } }> }).hubs.get("local")?.child.pid;
    return { manager, pid };
  }
  it("keeps running hubs when saved settings do not change them", async () => {
    const { manager, pid } = await running();
    try {
      const before = pid();
      expect(before).toBeGreaterThan(0);
      await manager.configure({ ...settings(), node: process.execPath });
      await manager.configure({ ...settings(), node: process.execPath, agentControl: true, hosts: [{ id: "local", name: "This Mac" }, { id: "mac", name: "Mac", ssh: "device-mac", remoteDirectory: "/tmp/tools" }] });
      expect(pid()).toBe(before);
      await manager.configure({ ...settings(), node: "/usr/bin/other-node" });
      expect(pid()).toBeUndefined();
    } finally { manager.dispose(); }
  });
});
