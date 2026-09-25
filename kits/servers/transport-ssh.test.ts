import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AskpassBridge, type AskpassRequest, type CredentialSource } from "./askpass";
import { findSftpServer, startFakeSshServer } from "./fixtures/fake-ssh-server.mjs";
import { hasCommand } from "./fixtures/run-command";
import { paths, readCalls, startTestSshAgent, type TestSshAgent } from "./fixtures/servers-test-env.mjs";
import { ServerPathError } from "./server-fs";
import type { SshTarget } from "./ssh-target";
import { parseProbe, SshConnections, SshTransport } from "./transport-ssh";

type Started = Awaited<ReturnType<typeof startFakeSshServer>>;

const ready = hasCommand("ssh") && Boolean(findSftpServer()) && process.platform !== "win32";
const PASSWORD = "pw-5b0e1d-only-here";

/** Answers like a user would: yes to the host key, the password from the script. */
class ScriptedSource implements CredentialSource {
  readonly requests: AskpassRequest[] = [];
  constructor(private readonly script: Partial<Record<AskpassRequest["kind"], Array<string | null>>>) {}
  async answer(request: AskpassRequest): Promise<string | null | undefined> {
    this.requests.push(request);
    const queue = this.script[request.kind];
    return queue?.length ? queue.shift() : null;
  }
}

interface Fixture {
  dir: string;
  server: Started;
  controlRoot: string;
  env: NodeJS.ProcessEnv;
}

async function fixture(options: { agent?: TestSshAgent } = {}): Promise<Fixture> {
  // Short paths: socket paths are capped near 104 bytes.
  const dir = mkdtempSync("/tmp/tau-ssh-t-");
  const server = await startFakeSshServer({ dir, password: PASSWORD });
  const controlRoot = mkdtempSync("/tmp/tau-ctl-");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TAU_SERVERS_SSH_CONFIG: paths(dir).sshConfig,
    TAU_SERVERS_LOOPBACK_ONLY: "1",
    ...(options.agent ? { SSH_AUTH_SOCK: options.agent.socket } : {}),
  };
  return { dir, server, controlRoot, env };
}

function transport(f: Fixture, target: Partial<SshTarget>, source: CredentialSource, stateName = "state") {
  const askpass = new AskpassBridge({ stateDir: join(f.dir, stateName), socketDir: f.controlRoot, sources: [source] });
  const site = realpathSync(join(paths(f.dir).root, "site"));
  const t = new SshTransport({ id: "site", alias: "fake", host: "127.0.0.1", remotePath: site, ...target }, { ssh: "ssh", askpass, env: f.env, controlRoot: f.controlRoot });
  return { transport: t, askpass, site };
}

const authentications = (dir: string) => readCalls(dir).filter((call) => call.event === "authenticated").length;
const connections = (dir: string) => readCalls(dir).filter((call) => call.event === "connect").length;

describe("parseProbe", () => {
  it("reads the shell probe and treats anything else as SFTP only", () => {
    expect(parseProbe("tau\n/home/u\nLinux\n/usr/bin/sha256sum\n/usr/bin/tar\n")).toEqual({ shell: true, home: "/home/u", os: "Linux", commands: ["sha256sum", "tar"] });
    expect(parseProbe("This service allows sftp connections only.\n")).toEqual({ shell: false, commands: [] });
  });
});

describe.skipIf(!ready)("SshTransport with a key from the test agent", () => {
  let f: Fixture;
  let agent: TestSshAgent;
  let source: ScriptedSource;
  let t: SshTransport;
  let askpass: AskpassBridge;
  let site: string;

  beforeAll(async () => {
    f = await fixture();
    // The agent holds the plain test key; ssh gets only its public half, so the agent has to sign.
    agent = await startTestSshAgent(f.dir);
    f.env.SSH_AUTH_SOCK = agent.socket;
    source = new ScriptedSource({ "host-key": ["yes"] });
    ({ transport: t, askpass, site } = transport(f, { privateKeyPath: `${paths(f.dir).key}.pub` }, source));
  }, 30_000);

  afterAll(async () => {
    await t?.close();
    await askpass?.close();
    agent?.stop();
    await agent?.exited;
    await f?.server.close();
    if (f) {
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(f.controlRoot, { recursive: true, force: true });
    }
  });

  it("asks about the unknown host key once, then logs in with the agent's key", async () => {
    await t.connect();
    const hostKey = source.requests.filter((request) => request.kind === "host-key");
    expect(hostKey).toHaveLength(1);
    expect(hostKey[0]!.fingerprint).toBe(f.server.fingerprint);
    expect(source.requests.some((request) => request.kind === "password")).toBe(false);
    expect(readCalls(f.dir)).toContainEqual(expect.objectContaining({ event: "auth", method: "publickey", ok: true }));
    expect(readFileSync(paths(f.dir).knownHosts, "utf8")).toContain("ssh-ed25519");
    expect(t.root).toBe(site);
    expect(t.scratch).toBe(realpathSync(join(paths(f.dir).home, "tmp")));
    expect(t.caps).toMatchObject({ exec: true, atomicRename: true, chmod: true, mtimeSet: true });
  });

  it("runs every later call through the one ControlMaster login", async () => {
    await t.connect();
    const before = authentications(f.dir);
    expect(before).toBe(1);
    expect((await t.list("")).map((entry) => entry.name)).toContain("index.php");
    expect((await t.read("index.php")).toString()).toContain("fake site");
    const exec = await t.exec("pwd; echo out; echo err >&2");
    expect(exec).toMatchObject({ code: 0, stdout: `${site}\nout\n`, stderr: "err\n", truncated: false, timedOut: false });
    await t.exec("true", { cwd: "tmp" });
    expect(authentications(f.dir)).toBe(1);
    expect(connections(f.dir)).toBe(1);
    const control = readdirSync(join(f.controlRoot, `tau-${process.getuid!()}`)).filter((name) => !name.startsWith("askpass-"));
    expect(control).toHaveLength(1);
    expect(statSync(join(f.controlRoot, `tau-${process.getuid!()}`)).mode & 0o777).toBe(0o700);
  });

  it("writes, renames over, stats, chmods and removes below remotePath and ~/tmp", async () => {
    await t.write("a.txt", Buffer.from("one"), { mode: 0o640 });
    await t.write(".a.txt.tau-tmp", Buffer.from("two"));
    await t.rename(".a.txt.tau-tmp", "a.txt");
    expect(readFileSync(join(site, "a.txt"), "utf8")).toBe("two");
    await t.chmod("a.txt", 0o600);
    await t.setMtime("a.txt", 1_600_000_000);
    expect(await t.stat("a.txt")).toMatchObject({ type: "file", size: 3, mode: 0o600, mtime: 1_600_000_000 });
    await t.mkdir("dir", { mode: 0o755 });
    await t.rmdir("dir");
    await t.remove("a.txt");
    expect(existsSync(join(site, "a.txt"))).toBe(false);
    await t.write("~/tmp/scratch.txt", Buffer.from("s"), { area: "tmp" });
    expect(readFileSync(join(paths(f.dir).home, "tmp", "scratch.txt"), "utf8")).toBe("s");
    await expect(t.write("b.txt", Buffer.from("x"), { area: "tmp" })).rejects.toBeInstanceOf(ServerPathError);
  });

  it("refuses a path outside remotePath and ~/tmp, a link out, .git and the root itself", async () => {
    writeFileSync(join(paths(f.dir).root, "secret.txt"), "outside");
    symlinkSync(join(paths(f.dir).root, "secret.txt"), join(site, "link-out"));
    mkdirSync(join(site, ".git"), { recursive: true });
    writeFileSync(join(site, ".git", "config"), "[core]");
    const calls = readCalls(f.dir).length;
    await expect(t.read("/etc/hosts")).rejects.toThrow(/outside/u);
    await expect(t.read("../secret.txt")).rejects.toThrow(/outside/u);
    await expect(t.read("link-out")).rejects.toThrow(/outside/u);
    await expect(t.write("link-out", Buffer.from("x"))).rejects.toThrow(/outside/u);
    await expect(t.list("/")).rejects.toBeInstanceOf(ServerPathError);
    await expect(t.read(".git/config")).rejects.toThrow(/\.git/u);
    await expect(t.remove("")).rejects.toThrow(/own folder/u);
    await expect(t.exec("ls", { cwd: "/etc" })).rejects.toThrow(/outside/u);
    // The link itself lies inside and may go; its target stays.
    await t.remove("link-out");
    expect(readFileSync(join(paths(f.dir).root, "secret.txt"), "utf8")).toBe("outside");
    expect(readCalls(f.dir).slice(calls).filter((call) => call.event === "sftp-op" && /open|remove|opendir/u.test(String(call.line)) && call.outside)).toEqual([]);
  });

  it("caps output and stops a command at its timeout", async () => {
    const capped = await t.exec("head -c 5000 /dev/zero | tr '\\0' a", { maxOutputBytes: 100 });
    expect(capped.stdout).toHaveLength(100);
    expect(capped.truncated).toBe(true);
    // `exec`, so the fake's hangup reaches the sleep itself and nothing outlives the test.
    const slow = await t.exec("exec sleep 30", { timeoutMs: 300 });
    expect(slow.timedOut).toBe(true);
  });

  it("hashes files with the server's sha256sum or shasum", async () => {
    writeFileSync(join(site, "h.txt"), "hash me");
    const hashes = await t.hashMany(["h.txt", "missing.txt"]);
    expect(hashes.get("h.txt")).toBe(createHash("sha256").update("hash me").digest("hex"));
    expect(hashes.has("missing.txt")).toBe(false);
  });

  it("ends the master on close (ssh -O exit)", async () => {
    await t.close();
    const control = join(f.controlRoot, `tau-${process.getuid!()}`);
    const check = spawnSync("ssh", ["-F", paths(f.dir).sshConfig, "-o", `ControlPath=${control}/%C`, "-O", "check", "fake"], { env: f.env, encoding: "utf8" });
    expect(check.status).not.toBe(0);
    await expect(t.list("")).rejects.toThrow(/closed/u);
  });
});

describe.skipIf(!ready)("SshTransport with a password through askpass", () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await fixture();
  });

  afterAll(async () => {
    await f?.server.close();
    if (f) {
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(f.controlRoot, { recursive: true, force: true });
    }
  });

  it("asks again after a wrong password, logs in once and keeps the password out of every file", async () => {
    const source = new ScriptedSource({ "host-key": ["yes"], password: ["wrong", PASSWORD] });
    const { transport: t, askpass } = transport(f, { alias: "fake-password" }, source);
    try {
      await t.connect();
      await t.list("");
      await t.exec("true");
      expect(source.requests.filter((request) => request.kind === "password").map((request) => request.attempt)).toEqual([1, 2]);
      expect(authentications(f.dir)).toBe(1);
      expect(readCalls(f.dir)).toContainEqual(expect.objectContaining({ event: "auth", ok: false }));
    } finally {
      await t.close();
      await askpass.close();
    }
    const scan = (folder: string): string[] => readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) return scan(path);
      return entry.isFile() ? [path] : [];
    });
    for (const file of [...scan(f.dir), ...scan(f.controlRoot)]) expect(readFileSync(file, "utf8"), file).not.toContain(PASSWORD);
  });

  it("fails cleanly when the host key is turned down", async () => {
    writeFileSync(paths(f.dir).knownHosts, "");
    const source = new ScriptedSource({ "host-key": ["no"] });
    const { transport: t, askpass } = transport(f, { alias: "fake-password" }, source, "state-no");
    try {
      await expect(t.connect()).rejects.toThrow(/Could not connect.*[Hh]ost key verification failed/u);
      expect(source.requests.map((request) => request.kind)).toEqual(["host-key"]);
    } finally {
      await t.close();
      await askpass.close();
    }
  });
});

describe.skipIf(!ready)("the loopback guard in the transport", () => {
  let f: Fixture;

  beforeAll(async () => {
    f = await fixture();
  });

  afterAll(async () => {
    await f?.server.close();
    if (f) {
      rmSync(f.dir, { recursive: true, force: true });
      rmSync(f.controlRoot, { recursive: true, force: true });
    }
  });

  it("refuses anything but loopback before ssh connects", async () => {
    const custom = join(f.dir, "evil_config");
    writeFileSync(custom, "Host evil\n  HostName 192.0.2.1\nHost proxied\n  HostName 127.0.0.1\n  ProxyCommand nc %h %p\nHost jumpy\n  HostName 127.0.0.1\n  ProxyJump 192.0.2.7\n");
    const before = connections(f.dir);
    const source = new ScriptedSource({});
    for (const target of [
      { alias: undefined, host: "192.0.2.1" },
      { alias: "evil", sshConfigPath: custom },
      { alias: "proxied", sshConfigPath: custom },
      { alias: "jumpy", sshConfigPath: custom },
      { alias: "fake", hop: [{ host: "192.0.2.9" }] },
    ]) {
      const { transport: t, askpass } = transport(f, target, source, "state-guard");
      await expect(t.connect()).rejects.toThrow(/Connection refused: loopback only/u);
      await askpass.close();
    }
    expect(connections(f.dir)).toBe(before);
    expect(source.requests).toHaveLength(0);
  });

  it("never falls back to the real ssh config while the guard is on", async () => {
    const env = { ...f.env };
    delete env.TAU_SERVERS_SSH_CONFIG;
    const askpass = new AskpassBridge({ stateDir: join(f.dir, "state-noconf"), socketDir: f.controlRoot, sources: [] });
    const t = new SshTransport({ id: "x", host: "127.0.0.1", remotePath: "/" }, { ssh: "ssh", askpass, env, controlRoot: f.controlRoot });
    await expect(t.connect()).rejects.toThrow(/never reads the real ssh config/u);
    await askpass.close();
  });
});

describe("SshConnections", () => {
  it("keeps one transport per project and target and closes a project's on its own", async () => {
    const closed: string[] = [];
    const registry = new SshConnections((target, workspace) => ({ target, close: async () => { closed.push(`${workspace}:${target.id}`); } }) as unknown as SshTransport);
    const a = registry.get("/p1", { id: "a", host: "127.0.0.1", remotePath: "/" });
    expect(registry.get("/p1", { id: "a", host: "127.0.0.1", remotePath: "/" })).toBe(a);
    registry.get("/p2", { id: "a", host: "127.0.0.1", remotePath: "/" });
    await registry.closeWorkspace("/p1");
    expect(closed).toEqual(["/p1:a"]);
    await registry.closeAll();
    expect(closed).toEqual(["/p1:a", "/p2:a"]);
  });
});
