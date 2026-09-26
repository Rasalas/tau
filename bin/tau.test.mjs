import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { defaultUserData } from "../src/main/host-service-units.ts";
import { appLauncher, askHost, main, parseArgs, readRunningHost, serviceLauncher, userDataDir } from "./tau.mjs";

const cleanups = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function temp() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "tau-cli-")));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

/** A host that speaks just enough of the protocol: hello with a token, one request. */
async function fakeHost(answer) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  const seen = { hellos: [], requests: [] };
  server.on("connection", (socket) => {
    socket.on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === "hello") {
        seen.hellos.push(frame.hello);
        if (frame.hello.token !== "secret") { socket.close(4401); return; }
        socket.send(JSON.stringify({ type: "hello-reply", id: frame.id, reply: { protocol: 1, hostVersion: "0", capabilities: [], resync: false, missed: [], nextSeq: 1 } }));
        return;
      }
      seen.requests.push(frame.request);
      const result = answer(frame.request);
      socket.send(JSON.stringify({ type: "response", response: { id: frame.request.id, ...(result instanceof Error ? { error: { message: result.message, code: "failed" } } : { result }) } }));
    });
  });
  return { url: `ws://127.0.0.1:${server.address().port}`, seen };
}

describe("tau app", () => {
  it("reads its arguments", () => {
    expect(parseArgs([])).toEqual({ help: true });
    expect(parseArgs(["app"])).toEqual({ command: "app", path: undefined });
    expect(parseArgs(["app", "../repo"])).toEqual({ command: "app", path: "../repo" });
    expect(() => parseArgs(["open"])).toThrow(/Unknown command/u);
    expect(() => parseArgs(["app", "a", "b"])).toThrow(/one folder/u);
  });

  it("finds the instance TAU_USER_DATA names, else the app's own folder", () => {
    expect(userDataDir({ TAU_USER_DATA: "/tmp/instance" }, "darwin", "/Users/me")).toBe("/tmp/instance");
    expect(userDataDir({}, "darwin", "/Users/me")).toBe("/Users/me/Library/Application Support/tau-pi-desktop-prototype");
    expect(userDataDir({ XDG_CONFIG_HOME: "/cfg" }, "linux", "/home/me")).toBe("/cfg/tau-pi-desktop-prototype");
  });

  it("only trusts a host.json whose process still runs", async () => {
    const userData = await temp();
    await writeFile(join(userData, "token"), "secret\n");
    await writeFile(join(userData, "host.json"), JSON.stringify({ pid: 4242, url: "ws://127.0.0.1:1", tokenPath: join(userData, "token") }));
    expect(readRunningHost(userData, () => false)).toBeUndefined();
    expect(readRunningHost(userData, (pid) => pid === 4242)).toEqual({ url: "ws://127.0.0.1:1", token: "secret" });
    expect(readRunningHost(join(userData, "missing"))).toBeUndefined();
  });

  it("asks the running host as an auxiliary client and prints what it opened", async () => {
    const folder = await temp();
    const host = await fakeHost((request) => ({ workspaceId: "ws1_x", displayPath: request.params[2].path, delivered: true, focused: true }));
    const lines = [];
    const code = await main(["app", folder], {
      out: (line) => lines.push(line),
      env: {},
      readRunningHost: () => ({ url: host.url, token: "secret" }),
      launch: () => { throw new Error("must not start the app"); },
    });
    expect(code).toBe(0);
    expect(host.seen.hellos).toEqual([{ protocol: 1, token: "secret", auxiliary: true }]);
    expect(host.seen.requests[0]).toMatchObject({ method: "host-extension", params: ["tau.workspace", "app-open", { path: folder }] });
    expect(lines).toEqual([`Opened ${folder} in Tau.`]);
  });

  it("opens a window for a host that runs without one, and starts the app when none runs", async () => {
    const folder = await temp();
    const host = await fakeHost(() => ({ workspaceId: "ws1_x", displayPath: folder, delivered: false, focused: false }));
    const launched = [];
    const io = { out: () => undefined, env: { TAU_USER_DATA: "/tmp/instance" }, launcher: { command: "tau-app", args: [], cwd: "/" }, launch: (launcher, env) => launched.push(env) };
    await main(["app", folder], { ...io, readRunningHost: () => ({ url: host.url, token: "secret" }) });
    await main(["app", folder], { ...io, readRunningHost: () => undefined });
    // The waiting request opens the folder in the first case; the new app opens it in the second.
    expect(launched).toEqual([{ TAU_USER_DATA: "/tmp/instance" }, { TAU_USER_DATA: "/tmp/instance", TAU_WORKSPACE: folder }]);
  });

  it("reports a refused token and a host error instead of starting a second app", async () => {
    const host = await fakeHost(() => new Error("/nope is not a folder."));
    await expect(askHost({ url: host.url, token: "wrong" }, "app-open", {})).rejects.toThrow(/closed the connection/u);
    await expect(askHost({ url: host.url, token: "secret" }, "app-open", {})).rejects.toThrow("/nope is not a folder.");
  });

  it("refuses a path that is not a folder", async () => {
    const folder = await temp();
    await writeFile(join(folder, "file.txt"), "");
    await expect(main(["app", "file.txt"], { cwd: folder, out: () => undefined, env: {} })).rejects.toThrow(/is not a folder/u);
  });
});

describe("tau service", () => {
  it("reads its action", () => {
    expect(parseArgs(["service", "install"])).toEqual({ command: "service", action: "install", flags: [] });
    expect(parseArgs(["service", "status"])).toEqual({ command: "service", action: "status", flags: [] });
    expect(parseArgs(["service"])).toEqual({ help: true });
    expect(() => parseArgs(["service", "start"])).toThrow(/Unknown service action/u);
    expect(() => parseArgs(["service", "status", "now"])).toThrow(/takes no arguments/u);
  });

  it("passes --display and --no-display to install only", async () => {
    expect(parseArgs(["service", "install", "--display"])).toEqual({ command: "service", action: "install", flags: ["--display"] });
    expect(parseArgs(["service", "install", "--no-display"])).toEqual({ command: "service", action: "install", flags: ["--no-display"] });
    expect(() => parseArgs(["service", "install", "--display", "--no-display"])).toThrow(/--display or --no-display/u);
    expect(() => parseArgs(["service", "status", "--display"])).toThrow(/takes no arguments/u);
    const runs = [];
    await main(["service", "install", "--display"], {
      out: () => undefined,
      env: { TAU_USER_DATA: "/tmp/instance" },
      serviceLauncher: { command: "/usr/lib/tau/tau", entry: "/x/service-cli.js" },
      runService: (_launcher, action, _env, flags) => { runs.push([action, ...flags]); return 0; },
    });
    expect(runs).toEqual([["install", "--display"]]);
  });

  it("runs the app's service command as Node, for the instance it names", async () => {
    const runs = [];
    const code = await main(["service", "status"], {
      out: () => undefined,
      env: { TAU_USER_DATA: "/tmp/instance", ELECTRON_RUN_AS_NODE: "0" },
      serviceLauncher: { command: "/Applications/Tau.app/Contents/MacOS/Tau", entry: "/x/service-cli.js" },
      runService: (launcher, action, env, flags) => { runs.push({ launcher, action, env, flags }); return 3; },
    });
    expect(code).toBe(3);
    expect(runs).toEqual([{
      launcher: { command: "/Applications/Tau.app/Contents/MacOS/Tau", entry: "/x/service-cli.js" },
      action: "status",
      env: { TAU_USER_DATA: "/tmp/instance", ELECTRON_RUN_AS_NODE: "1" },
      flags: [],
    }]);
  });

  it("finds the binary of an installed Tau beside its unpacked archive", async () => {
    const root = await temp();
    const unpacked = join(root, "Tau.app", "Contents", "Resources", "app.asar.unpacked");
    await mkdir(join(unpacked, "bin"), { recursive: true });
    await mkdir(join(unpacked, "dist-electron", "main"), { recursive: true });
    await mkdir(join(root, "Tau.app", "Contents", "MacOS"), { recursive: true });
    await writeFile(join(unpacked, "bin", "tau.mjs"), "");
    await writeFile(join(unpacked, "dist-electron", "main", "service-cli.js"), "");
    await writeFile(join(root, "Tau.app", "Contents", "MacOS", "Tau"), "");
    // Homebrew links the command line into its own bin; the link is resolved.
    await symlink(join(unpacked, "bin", "tau.mjs"), join(root, "tau"));
    expect(serviceLauncher(join(root, "tau"), "darwin")).toEqual({
      command: join(root, "Tau.app", "Contents", "MacOS", "Tau"),
      entry: join(unpacked, "dist-electron", "main", "service-cli.js"),
    });
    const linux = join(root, "linux", "resources", "app.asar.unpacked");
    await mkdir(join(linux, "bin"), { recursive: true });
    await mkdir(join(linux, "dist-electron", "main"), { recursive: true });
    await writeFile(join(linux, "bin", "tau.mjs"), "");
    await writeFile(join(linux, "dist-electron", "main", "service-cli.js"), "");
    expect(serviceLauncher(join(linux, "bin", "tau.mjs"), "linux")).toBeUndefined();
    await writeFile(join(root, "linux", "tau"), "");
    expect(serviceLauncher(join(linux, "bin", "tau.mjs"), "linux")?.command).toBe(join(root, "linux", "tau"));
    // `tau app` without a running Tau starts that same binary.
    expect(appLauncher({}, join(linux, "bin", "tau.mjs"), "linux")).toEqual({ command: join(root, "linux", "tau"), args: [], cwd: join(root, "linux") });
  });

  it("names the default userData as the service does", () => {
    expect(userDataDir({}, "darwin", "/Users/me")).toBe(defaultUserData("darwin", "/Users/me", {}));
    expect(userDataDir({ XDG_CONFIG_HOME: "/cfg" }, "linux", "/home/me")).toBe(defaultUserData("linux", "/home/me", { XDG_CONFIG_HOME: "/cfg" }));
  });
});
