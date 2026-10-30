import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFile, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { DeviceManager, remoteHubCommand, validateSettings } from "./manager.js";
import { DEFAULT_SETTINGS, TOOLS, type DeviceSettings } from "./protocol.js";
import { quote, run, type Run } from "./process.js";
import { Toolchain } from "./toolchain.js";
import { deviceTools } from "./host.js";
import { TUNNEL_TIMING, tunnelArgs } from "./tunnel.js";
import { PRUNE_SCRIPT, SYNC_MANIFEST, extractCommand, pruneCommand, remoteProjectPath } from "./project-sync.js";
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
  async function fixture(launch: typeof spawn = spawn) {
    const path = await directory();
    const execute: Run = vi.fn(async (command, args) => ({ stdout: command === "emulator" ? "" : args.includes("SIMULATOR_MAINSCREEN_SCALE") ? "3" : "native output", stderr: "" }));
    const manager = new DeviceManager(path, execute, fetch, launch);
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
  it("lists every configured machine for an agent that names none, keeping an unreachable one's error", async () => {
    // The SSH machine's session ends at once, as an unreachable Mac's would.
    const { manager } = await fixture((() => Object.assign(new EventEmitter(), { exitCode: 255, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true })) as unknown as typeof spawn);
    try {
      await manager.configure({ ...settings(), node: process.execPath, agentControl: true, hosts: [{ id: "local", name: "This machine" }, { id: "ssh-1", name: "Build Mac", ssh: "build-mac", remoteDirectory: "/Users/me/tau-devices" }] });
      const [list] = deviceTools(manager);
      const text = (content: { type: string; text?: string }[]) => content[0]!.type === "text" ? content[0]!.text! : "";
      const answer = JSON.parse(text((await list.execute("1", {}, undefined, undefined, undefined!)).content)) as { hosts: { id: string; name: string; remote: boolean; devices?: { id: string; hostId: string }[]; error?: string }[] };
      expect(answer.hosts.map(({ id, name, remote }) => ({ id, name, remote }))).toEqual([{ id: "local", name: "This machine", remote: false }, { id: "ssh-1", name: "Build Mac", remote: true }]);
      expect(answer.hosts[0].devices?.map((device) => [device.id, device.hostId])).toEqual([["ios-phone", "local"], ["android-phone", "local"]]);
      expect(answer.hosts[1]).toMatchObject({ error: expect.any(String) });
      expect(answer.hosts[1].devices).toBeUndefined();
      const single = JSON.parse(text((await list.execute("2", { hostId: "local" }, undefined, undefined, undefined!)).content)) as unknown[];
      expect(single).toHaveLength(2);
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


describe("forwarded ports", () => {
  const remote = (forwardPorts: unknown) => ({ ...settings(), hosts: [...settings().hosts, { id: "mac", name: "Mac", ssh: "mac", remoteDirectory: "/tmp/tools", forwardPorts }] });
  it("accepts up to eight distinct unprivileged ports and leaves an empty list out", () => {
    expect(validateSettings(remote([8081, 19000])).hosts[1]!.forwardPorts).toEqual([8081, 19000]);
    expect(validateSettings(remote([])).hosts[1]).not.toHaveProperty("forwardPorts");
    expect(validateSettings(remote(undefined)).hosts[1]).not.toHaveProperty("forwardPorts");
    expect(validateSettings(remote([1024, 65535])).hosts[1]!.forwardPorts).toEqual([1024, 65535]);
  });
  it("refuses privileged, out-of-range, fractional, repeated, too many or non-numeric ports", () => {
    for (const ports of [[80], [1023], [65536], [8081.5], [Number.NaN], [null], ["8081"], [-8081]]) expect(() => validateSettings(remote(ports))).toThrow("1024 to 65535");
    expect(() => validateSettings(remote([8081, 8081]))).toThrow("only once");
    expect(() => validateSettings(remote([8081, 8082, 8083, 8084, 8085, 8086, 8087, 8088, 8089]))).toThrow("at most 8");
    expect(() => validateSettings(remote("8081"))).toThrow("list");
  });
});

interface FakeChild extends EventEmitter { exitCode: number | null; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> }
function fakeChild(): FakeChild {
  const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  child.kill.mockImplementation(() => { child.exitCode = 143; child.emit("close", 143); return true; });
  return child;
}
async function exit(child: FakeChild, code: number, stderr = "") {
  if (stderr) child.stderr.write(stderr);
  await new Promise((resolve) => setImmediate(resolve));
  child.exitCode = code; child.emit("close", code);
}

describe("port tunnel lifetime", () => {
  afterEach(() => { vi.useRealTimers(); });
  async function tunnelled() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const spawned: { args: readonly string[]; child: FakeChild }[] = [];
    const own = vi.fn((input: { command: string; args: readonly string[] }) => { expect(input.command).toBe("ssh"); const child = fakeChild(); spawned.push({ args: input.args, child }); return child as unknown as ReturnType<typeof spawn>; });
    const launch = vi.fn() as unknown as typeof spawn;
    const manager = new DeviceManager(await directory(), vi.fn(), fetch, launch, own);
    const host = { id: "mac", name: "Mac", ssh: "device-mac", remoteDirectory: "/tmp/tools" };
    const configure = (forwardPorts?: number[]) => manager.configure({ ...settings(), hosts: [...settings().hosts, { ...host, ...(forwardPorts ? { forwardPorts } : {}) }] });
    return { manager, spawned, own, launch, configure };
  }
  it("forwards each remote loopback port to this machine without weakening host-key checks", () => {
    const args = tunnelArgs("device-mac", [8081, 19000]);
    expect(args).toEqual(["-N", "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3", "-R", "127.0.0.1:8081:127.0.0.1:8081", "-R", "127.0.0.1:19000:127.0.0.1:19000", "--", "device-mac"]);
    expect(args.join(" ")).not.toMatch(/StrictHostKeyChecking|UserKnownHostsFile|CheckHostIP/);
  });
  it("runs a separate owned ssh session, reports its failure and retries with a bounded backoff", async () => {
    const { manager, spawned, launch, configure } = await tunnelled();
    try {
      await configure([8081]);
      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.args).toEqual(tunnelArgs("device-mac", [8081]));
      expect(launch).not.toHaveBeenCalled();
      expect((await manager.state()).tunnels).toEqual({ mac: { ports: [8081], status: "connecting" } });
      await exit(spawned[0]!.child, 255, "Error: remote port forwarding failed for listen port 8081\n");
      expect((await manager.state()).tunnels?.mac).toEqual({ ports: [8081], status: "failed", error: "Error: remote port forwarding failed for listen port 8081" });
      const listing = await manager.discoverAll();
      expect(listing.hosts[1]).toMatchObject({ id: "mac", ssh: "device-mac", tunnel: { status: "failed", error: expect.stringContaining("8081") } });
      await vi.advanceTimersByTimeAsync(TUNNEL_TIMING.firstRetry - 1);
      expect(spawned).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(spawned).toHaveLength(2);
      expect((await manager.state()).tunnels?.mac).toMatchObject({ status: "connecting", error: expect.stringContaining("8081") });
      await exit(spawned[1]!.child, 255);
      await vi.advanceTimersByTimeAsync(TUNNEL_TIMING.firstRetry * 2 - 1);
      expect(spawned).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(spawned).toHaveLength(3);
      // Repeated failures never wait longer than the cap.
      for (let attempt = 3; attempt < 12; attempt++) { await exit(spawned.at(-1)!.child, 255); await vi.advanceTimersByTimeAsync(TUNNEL_TIMING.maxRetry); expect(spawned).toHaveLength(attempt + 1); }
      await vi.advanceTimersByTimeAsync(TUNNEL_TIMING.runningAfter);
      expect((await manager.state()).tunnels?.mac).toEqual({ ports: [8081], status: "running" });
    } finally { manager.dispose(); }
  });
  it("restarts the tunnel only when its machine's ports change and stops it on removal and deactivation", async () => {
    const { manager, spawned, configure } = await tunnelled();
    await configure([8081]);
    await configure([8081]);
    expect(spawned).toHaveLength(1);
    await configure([8081, 19000]);
    expect(spawned[0]!.child.kill).toHaveBeenCalled();
    expect(spawned).toHaveLength(2);
    expect(spawned[1]!.args).toContain("127.0.0.1:19000:127.0.0.1:19000");
    await configure();
    expect(spawned[1]!.child.kill).toHaveBeenCalled();
    expect((await manager.state()).tunnels).toEqual({});
    await configure([8081]);
    expect(spawned).toHaveLength(3);
    manager.dispose();
    expect(spawned[2]!.child.kill).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(TUNNEL_TIMING.maxRetry * 2);
    expect(spawned).toHaveLength(3);
  });
  it("starts the saved tunnels when the extension activates", async () => {
    const path = await directory();
    await writeFile(join(path, "settings.json"), JSON.stringify({ ...settings(), hosts: [...settings().hosts, { id: "mac", name: "Mac", ssh: "device-mac", remoteDirectory: "/tmp/tools", forwardPorts: [8081] }] }));
    const own = vi.fn(() => fakeChild() as unknown as ReturnType<typeof spawn>);
    const manager = new DeviceManager(path, vi.fn(), fetch, vi.fn() as unknown as typeof spawn, own);
    await manager.state();
    expect(own).toHaveBeenCalledTimes(1);
    manager.dispose();
  });
});

describe("project sync", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  /** Runs what would run on the Mac in a local shell, with node on the PATH, as a login shell over ssh would. */
  function loopbackSsh(commands: string[][]): typeof spawn {
    return ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
      if (command !== "ssh") return spawn(command, args, options);
      commands.push(args);
      return spawn("sh", ["-c", args.at(-1)!], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` } });
    }) as unknown as typeof spawn;
  }
  it("runs the remote prune script so it deletes only files the previous sync sent", async () => {
    const base = await directory(), root = join(base, "copy root"), outside = join(base, "outside");
    await mkdir(join(root, "sub"), { recursive: true }); await mkdir(outside);
    for (const file of ["keep.txt", "gone.txt", "sub/gone too.txt", "made-on-mac.txt"]) await writeFile(join(root, file), file);
    await writeFile(join(base, "escape.txt"), "outside"); await writeFile(join(outside, "inner.txt"), "outside");
    await symlink(outside, join(root, "link"));
    const prune = (files: string[]) => spawnSync(process.execPath, ["-e", PRUNE_SCRIPT, root], { input: JSON.stringify({ files }), encoding: "utf8" });
    // Without a manifest nothing is old, so nothing goes.
    expect(JSON.parse(prune(["keep.txt"]).stdout)).toEqual({ removed: 0 });
    expect(existsSync(join(root, "gone.txt"))).toBe(true);
    await writeFile(join(root, SYNC_MANIFEST), JSON.stringify({ version: 1, files: ["keep.txt", "gone.txt", "sub/gone too.txt", "../escape.txt", join(base, "escape.txt"), "link/inner.txt", "sub", "missing.txt"] }));
    const answer = prune(["keep.txt", "new.txt"]);
    expect(answer.status).toBe(0);
    expect(JSON.parse(answer.stdout)).toEqual({ removed: 2 });
    for (const file of ["gone.txt", "sub/gone too.txt"]) expect(existsSync(join(root, file))).toBe(false);
    for (const file of [join(root, "keep.txt"), join(root, "made-on-mac.txt"), join(root, "sub"), join(base, "escape.txt"), join(outside, "inner.txt")]) expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(join(root, SYNC_MANIFEST), "utf8"))).toEqual({ version: 1, files: ["keep.txt", "new.txt"] });
  });
  it("names the remote copy by project name and path hash", () => {
    expect(remoteProjectPath("/Users/me/tau tools/", "/home/me/My App")).toMatch(/^\/Users\/me\/tau tools\/projects\/My App-[0-9a-f]{8}$/);
    expect(remoteProjectPath("/r", "/a/app")).not.toBe(remoteProjectPath("/r", "/b/app"));
  });
  it("streams the Git file list with tar over ssh, quotes paths with spaces and prunes on a second sync", async () => {
    const base = await directory(), project = join(base, "my app"), remoteDirectory = join(base, "Tau's remote tools");
    await mkdir(join(project, "dir with space"), { recursive: true }); await mkdir(join(project, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(project, ".gitignore"), "node_modules/\n");
    for (const file of ["a.txt", "dir with space/b.txt", "-dash.txt", "it's.txt", "untracked.txt"]) await writeFile(join(project, file), file);
    await writeFile(join(project, "node_modules", "pkg", "index.js"), "ignored");
    git(project, "init", "-q"); git(project, "add", "--", ".gitignore", "a.txt", "dir with space/b.txt", "-dash.txt", "it's.txt");
    const commands: string[][] = [];
    const manager = new DeviceManager(await directory(), run, fetch, loopbackSsh(commands), vi.fn());
    try {
      await manager.configure({ ...settings(), hosts: [...settings().hosts, { id: "mac", name: "Mac", ssh: "device-mac", remoteDirectory }] });
      const first = await manager.syncProject("mac", project);
      const remotePath = remoteProjectPath(remoteDirectory, project);
      expect(first).toMatchObject({ hostId: "mac", hostName: "Mac", ssh: "device-mac", projectPath: project, remotePath, files: 6, removed: 0, forwardPorts: [] });
      expect(commands.map((args) => args.at(-1))).toEqual([extractCommand(remotePath), pruneCommand(remotePath)]);
      expect(commands[0]!.slice(0, -2)).toEqual(["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--"]);
      expect(commands[0]!.at(-2)).toBe("device-mac");
      expect(extractCommand(remotePath)).toBe(`mkdir -p ${quote(remotePath)} && tar -xf - -C ${quote(remotePath)}`);
      for (const file of [".gitignore", "a.txt", "dir with space/b.txt", "-dash.txt", "it's.txt", "untracked.txt"]) expect(readFileSync(join(remotePath, file), "utf8")).toBe(readFileSync(join(project, file), "utf8"));
      expect(existsSync(join(remotePath, "node_modules"))).toBe(false);
      expect(first.hint).toContain("ssh device-mac ");
      expect(first.hint).toContain("npx expo run:ios");
      // What the Mac made itself stays; what disappeared here goes.
      await mkdir(join(remotePath, "node_modules", "react"), { recursive: true }); await writeFile(join(remotePath, "node_modules", "react", "index.js"), "mac");
      await mkdir(join(remotePath, "ios", "Pods"), { recursive: true }); await writeFile(join(remotePath, "ios", "Pods", "Manifest.lock"), "mac");
      await rm(join(project, "a.txt")); await rm(join(project, "untracked.txt"));
      await writeFile(join(project, "dir with space", "b.txt"), "changed");
      const second = await manager.syncProject("mac", project);
      expect(second).toMatchObject({ files: 4, removed: 2 });
      expect(existsSync(join(remotePath, "a.txt"))).toBe(false);
      expect(existsSync(join(remotePath, "untracked.txt"))).toBe(false);
      expect(readFileSync(join(remotePath, "dir with space", "b.txt"), "utf8")).toBe("changed");
      expect(readFileSync(join(remotePath, "node_modules", "react", "index.js"), "utf8")).toBe("mac");
      expect(readFileSync(join(remotePath, "ios", "Pods", "Manifest.lock"), "utf8")).toBe("mac");
    } finally { manager.dispose(); }
  });
  it("tells the agent about forwarded Metro ports and keeps the bundler here", async () => {
    const base = await directory(), project = join(base, "app");
    await mkdir(project); await writeFile(join(project, "App.tsx"), "app"); git(project, "init", "-q");
    const manager = new DeviceManager(await directory(), run, fetch, loopbackSsh([]), vi.fn(() => fakeChild() as unknown as ReturnType<typeof spawn>));
    try {
      await manager.configure({ ...settings(), hosts: [...settings().hosts, { id: "mac", name: "Mac", ssh: "device-mac", remoteDirectory: join(base, "tools"), forwardPorts: [8081] }] });
      const result = await manager.syncProject("mac", project);
      expect(result.forwardPorts).toEqual([8081]);
      expect(result.hint).toContain("--no-bundler");
      expect(result.hint).toContain(`ssh device-mac 'cd ${result.remotePath} && npm install && npx expo run:ios --no-bundler --port 8081'`);
    } finally { manager.dispose(); }
  });
  it("refuses a folder outside Git, this machine and a relative path before contacting the device machine", async () => {
    const plain = await directory(), commands: string[][] = [];
    const manager = new DeviceManager(await directory(), run, fetch, loopbackSsh(commands), vi.fn());
    try {
      await manager.configure({ ...settings(), hosts: [...settings().hosts, { id: "mac", name: "Mac", ssh: "device-mac", remoteDirectory: "/tmp/tools" }] });
      await expect(manager.syncProject("mac", plain)).rejects.toThrow("is not a Git repository");
      await expect(manager.syncProject("local", plain)).rejects.toThrow("SSH machine");
      await expect(manager.syncProject("mac", "relative/app")).rejects.toThrow("absolute");
      expect(commands).toEqual([]);
    } finally { manager.dispose(); }
  });
  it("runs the agent tool only with consent and a project the thread or host knows", async () => {
    const execute: Run = vi.fn(async () => ({ stdout: "", stderr: "" }));
    const launch = vi.fn() as unknown as typeof spawn;
    const manager = new DeviceManager(await directory(), execute, fetch, launch, vi.fn());
    const known = vi.fn(async (path: string) => { if (path !== "/work/app") throw new Error("unknown"); return path; });
    const tool = (cwd?: string) => deviceTools(manager, { cwd, known }).find((entry) => entry.name === "device_sync_project")!;
    try {
      await manager.configure({ ...settings(), hosts: [...settings().hosts, { id: "mac", name: "Mac", ssh: "device-mac", remoteDirectory: "/tmp/tools" }] });
      await expect(tool("/work/app").execute("1", { hostId: "mac" }, undefined, undefined, undefined!)).rejects.toThrow("off");
      expect(execute).not.toHaveBeenCalled();
      await manager.configure({ ...settings(), agentControl: true, hosts: [...settings().hosts, { id: "mac", name: "Mac", ssh: "device-mac", remoteDirectory: "/tmp/tools" }] });
      await expect(tool().execute("2", { hostId: "mac" }, undefined, undefined, undefined!)).rejects.toThrow("no project folder");
      await expect(tool().execute("3", { hostId: "mac", projectPath: "app" }, undefined, undefined, undefined!)).rejects.toThrow("absolute");
      await expect(tool().execute("4", { hostId: "mac", projectPath: "/etc" }, undefined, undefined, undefined!)).rejects.toThrow("not a project open in Tau");
      expect(execute).not.toHaveBeenCalled();
      // A known project reaches Git, whose refusal the fake gives.
      vi.mocked(execute).mockRejectedValueOnce(new Error("fatal: not a git repository (or any of the parent directories): .git"));
      await expect(tool().execute("5", { hostId: "mac", projectPath: "/work/app" }, undefined, undefined, undefined!)).rejects.toThrow("/work/app is not a Git repository");
      expect(vi.mocked(execute).mock.calls[0]![1]).toEqual(["-C", "/work/app", "rev-parse", "--is-inside-work-tree"]);
      expect(launch).not.toHaveBeenCalled();
    } finally { manager.dispose(); }
  });
});
