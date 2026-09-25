import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureControlDir, expandLocalPath, isLoopbackHost, loopbackRefusal, parseSshG, shellQuote, sshBaseArgs, type SshTarget } from "./ssh-target";

const target = (extra: Partial<SshTarget> = {}): SshTarget => ({ id: "t", host: "example.com", remotePath: "/var/www", ...extra });

describe("sshBaseArgs", () => {
  it("builds the destination from host, user and port, with ControlMaster under the folder", () => {
    const { args, destination } = sshBaseArgs(target({ username: "deploy", port: 2222 }), { configPath: "/cfg", controlDir: "/tmp/tau-501" });
    expect(destination).toBe("example.com");
    expect(args.slice(0, 6)).toEqual(["-F", "/cfg", "-l", "deploy", "-p", "2222"]);
    expect(args).toContain("ControlMaster=auto");
    expect(args).toContain("ControlPath=/tmp/tau-501/%C");
    expect(args).toContain("ControlPersist=10m");
    expect(args).toContain("BatchMode=no");
  });

  it("leaves user and port to the config for an alias, and has no ControlMaster without a folder (Windows)", () => {
    const { args, destination } = sshBaseArgs(target({ alias: "prod", username: "ignored", port: 1 }));
    expect(destination).toBe("prod");
    expect(args).not.toContain("-l");
    expect(args).not.toContain("-p");
    expect(args.join(" ")).not.toContain("Control");
  });

  it("maps key, agent, known_hosts, jumps and host verification", () => {
    const { args } = sshBaseArgs(target({
      privateKeyPath: "keys/id", agent: "~/agent.sock", knownHostsPath: "/k h/known", hostVerification: false,
      hop: [{ host: "jump.example.com", username: "j", port: 2200 }, { host: "::1" }],
    }), { baseDir: "/project", home: "/home/me" });
    expect(args).toEqual(expect.arrayContaining(["-i", "/project/keys/id", "IdentitiesOnly=yes", "IdentityAgent=/home/me/agent.sock", "UserKnownHostsFile=\"/k h/known\"", "StrictHostKeyChecking=accept-new"]));
    expect(args[args.indexOf("-J") + 1]).toBe("j@jump.example.com:2200,[::1]");
  });

  it("a target's own sshConfigPath wins over the environment's", () => {
    const { args } = sshBaseArgs(target({ sshConfigPath: "$CFG_DIR/config" }), { configPath: "/env", env: { CFG_DIR: "/etc/tau" } });
    expect(args.slice(0, 2)).toEqual(["-F", "/etc/tau/config"]);
  });

  it("refuses what ssh would read as an option", () => {
    expect(() => sshBaseArgs(target({ host: "-oProxyCommand=x" }))).toThrow(/not a host/u);
    expect(() => sshBaseArgs(target({ alias: "-F" }))).toThrow(/not a host/u);
    expect(() => sshBaseArgs(target({ username: "-x" }))).toThrow(/user name/u);
    expect(() => sshBaseArgs(target({ host: "a b" }))).toThrow(/not a host/u);
    expect(() => sshBaseArgs(target({ hop: [{ host: "-J" }] }))).toThrow(/jump host/u);
  });
});

describe("the loopback guard", () => {
  it("knows loopback in its spellings", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]", "::ffff:127.0.0.1"]) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ["192.0.2.1", "example.com", "128.0.0.1", "::2", "localhost.example.com"]) expect(isLoopbackHost(host)).toBe(false);
  });

  it("refuses by what ssh -G resolved: the host, every jump, any ProxyCommand", () => {
    expect(loopbackRefusal(parseSshG("hostname 127.0.0.1\nport 2222\nproxycommand none\n"))).toBeUndefined();
    expect(loopbackRefusal(parseSshG("hostname 192.0.2.1\nport 22\n"))).toMatch(/192\.0\.2\.1/u);
    expect(loopbackRefusal(parseSshG("hostname 127.0.0.1\nproxyjump me@[::1]:22,jump.example.com\n"))).toMatch(/jump\.example\.com/u);
    expect(loopbackRefusal(parseSshG("hostname 127.0.0.1\nproxyjump ssh://me@127.0.0.1:2200\n"))).toBeUndefined();
    expect(loopbackRefusal(parseSshG("hostname 127.0.0.1\nproxycommand nc %h %p\n"))).toMatch(/ProxyCommand/u);
  });
});

describe("ensureControlDir", () => {
  let root: string | undefined;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

  it.skipIf(process.platform === "win32")("creates tau-<uid> with 0700 and tightens a loose one it owns", async () => {
    root = mkdtempSync("/tmp/tau-ctl-");
    const dir = await ensureControlDir(root);
    expect(dir).toBe(join(root, `tau-${process.getuid!()}`));
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    chmodSync(dir, 0o755);
    await ensureControlDir(root);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("refuses a symlink or a folder of another user", async () => {
    root = mkdtempSync("/tmp/tau-ctl-");
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), join(root, `tau-${process.getuid!()}`));
    await expect(ensureControlDir(root)).rejects.toThrow(/not a directory/u);
    mkdirSync(join(root, "tau-4242"));
    await expect(ensureControlDir(root, 4242)).rejects.toThrow(/another user/u);
  });
});

describe("helpers", () => {
  it("expands ~, variables and relative paths", () => {
    expect(expandLocalPath("~/.ssh/id", { home: "/h" })).toBe("/h/.ssh/id");
    expect(expandLocalPath("${A}/x", { env: { A: "/a" } })).toBe("/a/x");
    expect(expandLocalPath("rel", { baseDir: "/p" })).toBe("/p/rel");
  });

  it("quotes one shell word", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});
