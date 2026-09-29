import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  acceptOverSsh,
  addMachine,
  explainSshFailure,
  LINK_LIFETIME_MS,
  listMachines,
  openSshChannel,
  parseMachinesArgs,
  remoteCommand,
  removeMachine,
  sshArgs,
  sshTargetIsLoopback,
  updateMachine,
} from "./tau-machines.mjs";
import { main } from "./tau.mjs";

const cleanups = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function temp() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "tau-machines-")));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

const REX = { id: "rex-host-id", name: "rex", version: "0.8.0" };
const SELF = { id: "mini-host-id", name: "mini" };
const LINK = "https://192.0.2.10:7788/#pair=secret-code&pk=aa&host=rex-host-id";
const LOOPBACK_LINK = "http://127.0.0.1:4100/#pair=secret-code&host=rex-host-id";

/** The other machine's side of the SSH session, scripted: answers `add`'s lines with its own. */
function fakeChannel(script) {
  const sent = [];
  const queue = [...(script.initial ?? [])];
  return {
    sent,
    next: async () => queue.shift(),
    send(message) {
      sent.push(message);
      queue.push(...(script.on?.(message) ?? []));
    },
    end: async () => ({ code: 0, stderr: "" }),
    failure: async () => script.failure ?? { code: 0, stderr: "" },
  };
}

/** This computer's host: `machines-overview` answers from `machines`, `machines-pair` records its input. */
function fakeSession({ window = true, machines = [], pair } = {}) {
  const calls = [];
  const state = { machines: [...machines] };
  return {
    calls,
    hello: { host: SELF, owner: true },
    async request(method, params = []) {
      calls.push({ method, params });
      if (method === "machines-overview") return { window, machines: state.machines };
      if (method === "machines-pair") {
        const result = pair?.(params[0]) ?? { state: "added", machine: { id: REX.id, name: params[0].name ?? REX.name }, window, agents: params[0].agents ? { added: true } : undefined };
        if (result.state === "added") {
          const connected = { status: "connected", roundTripMs: 4 };
          state.machines = [{ id: REX.id, name: result.machine.name, ...(window ? { window: connected } : {}), ...(params[0].agents ? { agents: connected } : {}) }];
        }
        return result;
      }
      if (method === "machines-forget") return { id: REX.id, name: REX.name, window: true, agents: true };
      throw new Error(`unexpected ${method}`);
    },
  };
}

function capture() {
  const lines = [];
  return { lines, out: (line) => lines.push(line) };
}

const ready = { type: "ready", version: 1, host: REX };
const offer = (url = LINK, reachability = "network") => [{ type: "link", urls: [{ url: LOOPBACK_LINK, reachability: "loopback" }, ...(reachability === "network" ? [{ url, reachability }] : [])], expiresAt: new Date(Date.now() + LINK_LIFETIME_MS).toISOString() }];

describe("tau machines: arguments", () => {
  it("reads add, list and remove", () => {
    expect(parseMachinesArgs(["add", "--ssh", "rex"])).toEqual({ action: "add", ssh: "rex", json: false, agents: false, access: "full" });
    expect(parseMachinesArgs(["add", "--ssh", "me@rex.local", "--name", "Rex", "--agents", "--access", "read-only", "--json"]))
      .toEqual({ action: "add", ssh: "me@rex.local", name: "Rex", agents: true, access: "read-only", json: true });
    expect(parseMachinesArgs(["list", "--json"])).toEqual({ action: "list", json: true });
    expect(parseMachinesArgs(["remove", "rex"])).toEqual({ action: "remove", machine: "rex", json: false });
    expect(parseMachinesArgs(["accept-ssh"])).toEqual({ action: "accept-ssh" });
    expect(parseMachinesArgs([])).toEqual({ help: true });
    expect(parseMachinesArgs(["add", "--help"])).toEqual({ help: true });
  });

  it("refuses what it cannot run safely or does not know", () => {
    expect(() => parseMachinesArgs(["add"])).toThrow(/--ssh <target>/u);
    // An option smuggled in as the target would become ssh's own.
    expect(() => parseMachinesArgs(["add", "--ssh", "-oProxyCommand=touch /tmp/x"])).toThrow(/needs a value|not an ssh target/u);
    expect(() => parseMachinesArgs(["add", "--ssh", "rex host"])).toThrow(/not an ssh target/u);
    expect(() => parseMachinesArgs(["add", "--ssh", "rex", "--access", "admin"])).toThrow(/full or read-only/u);
    expect(() => parseMachinesArgs(["list", "--agents"])).toThrow(/does not know --agents/u);
    expect(() => parseMachinesArgs(["remove"])).toThrow(/one machine/u);
    expect(() => parseMachinesArgs(["pair"])).toThrow(/Unknown machines action/u);
  });
});

describe("tau machines: ssh", () => {
  it("never lets ssh ask, and puts nothing secret on its command line", () => {
    const args = sshArgs("rex");
    expect(args).toContain("BatchMode=yes");
    expect(args.indexOf("rex")).toBe(args.length - 2);
    expect(args.join(" ")).not.toMatch(/pair=|token/u);
    expect(args.at(-1)).toMatch(/^exec sh -c '/u);
  });

  it("says what went wrong in ssh's own terms", () => {
    expect(explainSshFailure("rex", 255, "tester@rex: Permission denied (publickey).\n")).toMatch(/without a password .*BatchMode=yes rex true/u);
    expect(explainSshFailure("rex", 255, "Host key verification failed.\n")).toMatch(/host key/u);
    expect(explainSshFailure("rex", 255, "ssh: Could not resolve hostname rex: nodename nor servname provided\n")).toMatch(/does not know the machine rex/u);
    expect(explainSshFailure("rex", 255, "ssh: connect to host rex port 22: Connection refused\n")).toMatch(/could not reach rex/u);
    expect(explainSshFailure("rex", 3, "")).toBe("ssh rex ended (exit 3) without a word.");
  });

  it("knows a target that points at this computer from ssh -G", () => {
    const answer = (host) => () => ({ stdout: `user tester\nhostname ${host}\nport 2222\n` });
    expect(sshTargetIsLoopback("fake", answer("127.0.0.1"))).toBe(true);
    expect(sshTargetIsLoopback("fake", answer("localhost"))).toBe(true);
    expect(sshTargetIsLoopback("rex", answer("192.168.1.20"))).toBe(false);
    expect(sshTargetIsLoopback("rex", () => ({ stdout: "" }))).toBe(false);
  });

  it("speaks JSON lines with a fake ssh, skipping a login banner, and keeps the link off argv", async () => {
    const dir = await temp();
    // The fake ssh: prints a banner, then echoes each line back as `{ echo }`.
    const fake = join(dir, "fake-ssh.mjs");
    await writeFile(fake, `import { createInterface } from "node:readline";
process.stdout.write("Welcome to rex\\n" + JSON.stringify({ type: "ready", argv: process.argv.slice(2) }) + "\\n");
for await (const line of createInterface({ input: process.stdin })) process.stdout.write(JSON.stringify({ echo: JSON.parse(line) }) + "\\n");
`);
    const seen = [];
    const channel = openSshChannel("rex", (command, args, options) => {
      seen.push([command, ...args]);
      return spawn(process.execPath, [fake, ...args], options);
    });
    const first = await channel.next(5_000);
    expect(first).toMatchObject({ type: "ready" });
    expect(first.argv).toEqual(sshArgs("rex"));
    channel.send({ type: "link", label: "mini" });
    expect(await channel.next(5_000)).toEqual({ echo: { type: "link", label: "mini" } });
    expect(await channel.end()).toMatchObject({ code: 0 });
    expect(seen[0][0]).toBe("ssh");
  });

  it("finds a Tau that knows `tau machines` on the other machine, and says so when there is none or an old one", async () => {
    const dir = await temp();
    const bin = join(dir, "bin");
    await mkdir(bin);
    const run = () => {
      const command = remoteCommand([]);
      const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", env: { HOME: dir, PATH: `${bin}:/usr/bin:/bin` } });
      return result.stdout.trim().split("\n").at(-1);
    };
    expect(JSON.parse(run())).toEqual({ type: "error", code: "no-tau" });
    await writeFile(join(bin, "tau"), "#!/bin/sh\necho 'Usage: tau app [path]'\n");
    await chmod(join(bin, "tau"), 0o755);
    expect(JSON.parse(run())).toEqual({ type: "error", code: "old-tau" });
    await writeFile(join(bin, "tau"), "#!/bin/sh\nif [ \"$1\" = --help ]; then echo '       tau machines list'; exit 0; fi\necho \"{\\\"ran\\\":\\\"$*\\\"}\"\n");
    expect(JSON.parse(run())).toEqual({ ran: "machines accept-ssh" });
  });
});

describe("tau machines add", () => {
  it("asks the other machine for a link, pairs this computer's window and agents with it, and checks the connection", async () => {
    const channel = fakeChannel({ initial: [ready], on: (message) => (message.type === "link" ? offer() : []) });
    const session = fakeSession();
    const { lines, out } = capture();
    const code = await addMachine({ ssh: "rex", agents: true, access: "read-only", name: "Rex" }, { out, session, openChannel: () => channel, isLoopbackTarget: () => false });
    expect(code).toBe(0);
    expect(channel.sent).toEqual([{ type: "link", version: 1, label: "mini", access: "read-only" }, { type: "done" }]);
    expect(session.calls.find((call) => call.method === "machines-pair").params[0]).toEqual({ link: LINK, agents: true, id: REX.id, name: "Rex" });
    expect(lines).toEqual(["Paired with Rex.", "  window: connected · 4 ms", "  agents: connected · 4 ms"]);
  });

  it("only checks a machine it keeps already", async () => {
    const connected = { status: "connected", roundTripMs: 7 };
    const channel = fakeChannel({ initial: [ready] });
    const session = fakeSession({ machines: [{ id: REX.id, name: "rex", window: connected, agents: connected }] });
    const { lines, out } = capture();
    expect(await addMachine({ ssh: "rex", agents: true, access: "full", json: true }, { out, session, openChannel: () => channel })).toBe(0);
    expect(channel.sent).toEqual([{ type: "bye" }]);
    expect(session.calls.some((call) => call.method === "machines-pair")).toBe(false);
    expect(JSON.parse(lines[0])).toEqual({ state: "known", machine: { id: REX.id, name: "rex" }, window: connected, agents: connected });
  });

  it("asks as the agents alone where no window runs, and refuses to pair nothing", async () => {
    const channel = fakeChannel({ initial: [ready], on: (message) => (message.type === "link" ? offer() : []) });
    const session = fakeSession({ window: false });
    const { out } = capture();
    expect(await addMachine({ ssh: "rex", agents: true, access: "full" }, { out, session, openChannel: () => channel, isLoopbackTarget: () => false })).toBe(0);
    expect(channel.sent[0]).toMatchObject({ type: "link", label: "mini · Agents" });

    const none = fakeChannel({ initial: [ready] });
    await expect(addMachine({ ssh: "rex", agents: false, access: "full" }, { out, session: fakeSession({ window: false }), openChannel: () => none }))
      .rejects.toThrow(/No Tau window runs on this computer.*--agents/u);
    expect(none.sent).toEqual([{ type: "bye" }]);
  });

  it("does not hand this computer a loopback address of the other machine", async () => {
    const channel = fakeChannel({ initial: [ready], on: (message) => (message.type === "link" ? offer(undefined, "loopback") : []) });
    const session = fakeSession();
    await expect(addMachine({ ssh: "rex", agents: false, access: "full" }, { out: () => undefined, session, openChannel: () => channel, isLoopbackTarget: () => false }))
      .rejects.toThrow(/reachable only on rex itself.*Network access/u);
    expect(channel.sent.at(-1)).toEqual({ type: "bye" });
    expect(session.calls.some((call) => call.method === "machines-pair")).toBe(false);

    // A target that is this computer (a test) may use it.
    const local = fakeChannel({ initial: [ready], on: (message) => (message.type === "link" ? offer(undefined, "loopback") : []) });
    const again = fakeSession();
    await addMachine({ ssh: "fake", agents: false, access: "full" }, { out: () => undefined, session: again, openChannel: () => local, isLoopbackTarget: () => true });
    expect(again.calls.find((call) => call.method === "machines-pair").params[0].link).toBe(LOOPBACK_LINK);
  });

  it("explains an ssh failure, a missing or old Tau there, and this computer itself", async () => {
    const failing = fakeChannel({ initial: [], failure: { code: 255, stderr: "tester@rex: Permission denied (publickey,password).\n" } });
    await expect(addMachine({ ssh: "rex", access: "full" }, { out: () => undefined, session: fakeSession(), openChannel: () => failing })).rejects.toThrow(/without a password/u);
    const old = fakeChannel({ initial: [{ type: "error", code: "old-tau" }] });
    await expect(addMachine({ ssh: "rex", access: "full" }, { out: () => undefined, session: fakeSession(), openChannel: () => old })).rejects.toThrow(/without `tau machines`. Update Tau there/u);
    const stopped = fakeChannel({ initial: [{ type: "error", code: "no-host", message: "Tau is not running on rex." }] });
    await expect(addMachine({ ssh: "rex", access: "full" }, { out: () => undefined, session: fakeSession(), openChannel: () => stopped })).rejects.toThrow("Tau is not running on rex.");
    const self = fakeChannel({ initial: [{ type: "ready", host: SELF }] });
    await expect(addMachine({ ssh: "localhost", access: "full" }, { out: () => undefined, session: fakeSession(), openChannel: () => self })).rejects.toThrow(/this computer's own Tau/u);
  });

  it("reports a refusal with what the other machine said", async () => {
    const channel = fakeChannel({ initial: [ready], on: (message) => (message.type === "link" ? offer() : message.type === "done" ? [{ type: "failed", message: "disk full" }] : []) });
    const session = fakeSession({ pair: () => ({ state: "denied" }) });
    await expect(addMachine({ ssh: "rex", access: "full" }, { out: () => undefined, session, openChannel: () => channel, isLoopbackTarget: () => false }))
      .rejects.toThrow("rex did not allow this computer: disk full.");
  });
});

describe("tau machines accept-ssh", () => {
  /** stdin as the other side writes it: lines pushed one at a time. */
  function input() {
    const queue = [];
    let wake;
    let ended = false;
    return {
      push(message) { queue.push(JSON.stringify(message)); wake?.(); },
      end() { ended = true; wake?.(); },
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (queue.length) { yield queue.shift(); continue; }
          if (ended) return;
          await new Promise((resolve) => { wake = resolve; });
          wake = undefined;
        }
      },
    };
  }

  function ownerSession({ requests = [] } = {}) {
    const calls = [];
    const state = { requests };
    return {
      calls,
      state,
      closed: false,
      hello: { host: REX, owner: true, hostVersion: "0.8.0" },
      async request(method, params = []) {
        calls.push({ method, params });
        if (method === "connections-create-link") {
          return { link: { id: "link-1", access: params[0].access, expiresAt: new Date(Date.now() + LINK_LIFETIME_MS).toISOString() }, code: "secret-code", urls: [{ url: LINK, reachability: "network", kind: "lan", label: "LAN" }] };
        }
        if (method === "connections-list") return { requests: state.requests };
        if (method === "connections-approve") return { approved: true };
        if (method === "connections-revoke-link") return { revoked: true };
        throw new Error(`unexpected ${method}`);
      },
      close() { this.closed = true; },
    };
  }

  it("makes a two-minute link and allows only the request that link brings", async () => {
    const lines = input();
    const written = [];
    const session = ownerSession({ requests: [{ id: "other", link: { id: "someone-elses" } }] });
    const done = acceptOverSsh({ write: (text) => written.push(JSON.parse(text)), lines, connect: async () => session, pollMs: 1 });
    lines.push({ type: "link", label: "mini", access: "read-only" });
    await expect.poll(() => written.length).toBe(2);
    expect(written).toEqual([
      { type: "ready", version: 1, host: { id: REX.id, name: REX.name, version: "0.8.0" } },
      { type: "link", urls: [{ url: LINK, reachability: "network", kind: "lan" }], expiresAt: expect.any(String) },
    ]);
    expect(session.calls[0]).toEqual({ method: "connections-create-link", params: [{ label: "mini", lifetimeMs: 120_000, access: "read-only" }] });
    session.state.requests = [...session.state.requests, { id: "ours", link: { id: "link-1", label: "mini" }, companion: { name: "mini · Agents" } }];
    await expect.poll(() => written.at(-1)).toEqual({ type: "approved" });
    lines.push({ type: "done" });
    expect(await done).toBe(0);
    expect(session.calls.filter((call) => call.method === "connections-approve")).toEqual([{ method: "connections-approve", params: ["ours", { access: "read-only" }] }]);
    expect(session.calls.some((call) => call.method === "connections-revoke-link")).toBe(false);
    expect(session.closed).toBe(true);
    expect(JSON.stringify(written)).not.toContain("secret-code\"");
  });

  it("revokes a link nobody used when the other side leaves", async () => {
    const lines = input();
    const written = [];
    const session = ownerSession();
    const done = acceptOverSsh({ write: (text) => written.push(JSON.parse(text)), lines, connect: async () => session, pollMs: 1 });
    lines.push({ type: "link", label: "mini" });
    await expect.poll(() => written.length).toBe(2);
    lines.end();
    expect(await done).toBe(0);
    expect(session.calls.at(-1)).toEqual({ method: "connections-revoke-link", params: ["link-1"] });
  });

  it("says Tau is not running rather than failing silently", async () => {
    const written = [];
    expect(await acceptOverSsh({ write: (text) => written.push(JSON.parse(text)), lines: input(), connect: async () => { throw new Error("Tau is not running on rex."); } })).toBe(1);
    expect(written).toEqual([{ type: "error", code: "no-host", message: "Tau is not running on rex." }]);
  });
});

describe("tau machines list and remove", () => {
  it("lists the window's and the agents' machines, and as JSON for agents", async () => {
    const connected = { status: "connected", roundTripMs: 3 };
    const session = fakeSession({ machines: [{ id: REX.id, name: "rex", window: connected, agents: { status: "refused", detail: "revoked there" } }] });
    const plain = capture();
    await listMachines({ json: false }, { ...plain, session });
    expect(plain.lines).toEqual(["rex  rex-host  window: connected · 3 ms  agents: refused, revoked there"]);
    const json = capture();
    await listMachines({ json: true }, { ...json, session });
    expect(JSON.parse(json.lines[0]).machines[0].id).toBe(REX.id);
    const empty = capture();
    await listMachines({ json: false }, { ...empty, session: fakeSession({ window: false }) });
    expect(empty.lines).toEqual(["(No Tau window runs on this computer: only the machines its agents reach are listed.)", "No machines. Pair one with tau machines add --ssh <target>."]);
  });

  it("forgets a machine and says the other one still lists this computer", async () => {
    const session = fakeSession();
    const { lines, out } = capture();
    await removeMachine({ machine: "rex", json: false }, { out, session });
    expect(session.calls).toEqual([{ method: "machines-forget", params: ["rex"] }]);
    expect(lines[0]).toMatch(/^Forgot rex \(its window entry and the agents' key\)\. rex lists this computer until its owner revokes it there/u);
  });

  it("runs through `tau machines` against a running host with its token", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => server.once("listening", resolve));
    cleanups.push(() => new Promise((resolve) => server.close(resolve)));
    const methods = [];
    server.on("connection", (socket) => socket.on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === "hello") {
        socket.send(JSON.stringify({ type: "hello-reply", id: frame.id, reply: { protocol: 1, hostVersion: "0", capabilities: [], resync: false, missed: [], nextSeq: 1, owner: true, host: SELF } }));
        return;
      }
      methods.push(frame.request.method);
      socket.send(JSON.stringify({ type: "response", response: { id: frame.request.id, result: { window: true, machines: [] } } }));
    }));
    const lines = [];
    const code = await main(["machines", "list", "--json"], {
      out: (line) => lines.push(line),
      env: { TAU_USER_DATA: "/nonexistent" },
      readRunningHost: () => ({ url: `ws://127.0.0.1:${server.address().port}`, token: "secret" }),
    });
    expect(code).toBe(0);
    expect(methods).toEqual(["machines-overview"]);
    expect(JSON.parse(lines[0])).toEqual({ window: true, machines: [] });
    await expect(main(["machines", "list"], { out: () => undefined, env: {}, readRunningHost: () => undefined })).rejects.toThrow(/Tau is not running on this computer/u);
  });
});

describe("tau update and tau machines update (K103)", () => {
  const status = { version: "0.7.6", phase: "waiting", latest: "0.7.14", channel: "stable", automatic: true, installer: "host", devicesMayInstall: true, runningTurns: 1 };

  it("reads its flags", () => {
    expect(parseMachinesArgs(["update", "rex"])).toEqual({ action: "update", machine: "rex", json: false, update: "install" });
    expect(parseMachinesArgs(["update", "rex", "--check", "--json"])).toEqual({ action: "update", machine: "rex", json: true, update: "check" });
    expect(() => parseMachinesArgs(["update"])).toThrow(/one machine/u);
    expect(() => parseMachinesArgs(["update", "rex", "--check", "--status"])).toThrow(/does not know --status/u);
  });

  it("updates another machine through this computer's host and window", async () => {
    const calls = [];
    const session = { hello: { host: SELF, owner: true }, async request(method, params, waitMs) { calls.push({ method, params, waitMs }); return { id: REX.id, name: "rex", update: status }; } };
    const { lines, out } = capture();
    expect(await updateMachine({ machine: "rex", update: "install", json: false }, { out, session })).toBe(0);
    expect(calls).toEqual([{ method: "machines-update", params: ["rex", "install"], waitMs: 11 * 60_000 }]);
    expect(lines).toEqual(["rex: Tau 0.7.6. Tau 0.7.14 installs when the running turns end."]);
    const failed = { ...session, request: async () => ({ id: REX.id, name: "rex", update: { ...status, phase: "failed", reason: "polkit did not allow the update helper" } }) };
    expect(await updateMachine({ machine: "rex", update: "install", json: false }, { out, session: failed })).toBe(1);
  });

  it("updates this machine through its running host", async () => {
    const requests = [];
    const openSession = async () => ({ request: async (method, params, waitMs) => { requests.push({ method, waitMs }); return { ...status, phase: "current", latest: "0.7.6" }; }, close: () => undefined });
    const { lines, out } = capture();
    expect(await main(["update", "--check"], { out, env: {}, readRunningHost: () => ({ url: "ws://x", token: "t" }), openSession })).toBe(0);
    expect(requests).toEqual([{ method: "update-check", waitMs: 11 * 60_000 }]);
    expect(lines).toEqual(["Tau 0.7.6. Up to date."]);
    const json = capture();
    await main(["update", "--status", "--json"], { ...json, env: {}, readRunningHost: () => ({ url: "ws://x", token: "t" }), openSession });
    expect(JSON.parse(json.lines[0])).toMatchObject({ phase: "current" });
    await expect(main(["update"], { out, env: {}, readRunningHost: () => undefined })).rejects.toThrow(/not running on this machine/u);
    await expect(main(["update", "--now"], { out, env: {} })).rejects.toThrow(/--check or --status/u);
  });
});
