import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { askHost, main, parseArgs, readRunningHost, userDataDir } from "./tau.mjs";

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
