import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isSshAlias, listSshHosts, parseManualTarget, parseSshG, resolveSshHost, type CommandRunner } from "./ssh-hosts.js";

const temps: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tau-ssh-hosts-"));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A home with `.ssh/config` and an include tree; never the real one. */
async function fakeHome(): Promise<{ home: string; config: string }> {
  const home = await tempDir();
  const ssh = join(home, ".ssh");
  await mkdir(join(ssh, "config.d"), { recursive: true });
  await writeFile(join(ssh, "config"), [
    "# test config",
    "Host fake site-a *.wild !neg",
    "  HostName 127.0.0.1",
    "  Port 2222",
    "  User tester",
    "Include config.d/*",
    "Include ~/.ssh/missing-is-fine",
    "Host=eq-form",
    "  HostName 127.0.0.2",
    "Match host other",
    "  User nobody",
    "Host *",
    "  ServerAliveInterval 5",
    "",
  ].join("\n"));
  await writeFile(join(ssh, "config.d", "10-work"), "Host work \"quoted alias\"\n  HostName 127.0.0.3\nInclude ~/.ssh/config\n");
  await writeFile(join(ssh, "config.d", "20-more"), "HOST fake more # a comment\n");
  await writeFile(join(ssh, "config.d", ".hidden"), "Host hidden\n");
  return { home, config: join(ssh, "config") };
}

describe("listSshHosts", () => {
  it("lists concrete aliases in order, following Include with globs, skipping patterns and repeats", async () => {
    const { home, config } = await fakeHome();
    const { hosts, problems } = await listSshHosts(config, { home });
    expect(hosts.map((host) => host.alias)).toEqual(["fake", "site-a", "work", "quoted alias", "more", "eq-form"]);
    expect(hosts[2]).toMatchObject({ file: join(home, ".ssh", "config.d", "10-work"), line: 1 });
    expect(problems).toEqual([]);
  });

  it("reports an unreadable config", async () => {
    const home = await tempDir();
    const result = await listSshHosts(join(home, "nope"), { home });
    expect(result.hosts).toEqual([]);
    expect(result.problems).toHaveLength(1);
  });
});

describe("resolveSshHost", () => {
  it("runs ssh -G with -F and -- before the alias", async () => {
    const calls: string[][] = [];
    const run: CommandRunner = async (_file, args) => {
      calls.push([...args]);
      return { stdout: "host fake\nuser tester\nhostname 127.0.0.1\nport 2222\nidentityfile ~/.ssh/a\nidentityfile ~/.ssh/b\nidentityagent none\nproxyjump jump@bastion\nuserknownhostsfile /k1 /k2\nstricthostkeychecking ask\n", stderr: "", code: 0 };
    };
    const resolved = await resolveSshHost("fake", { ssh: "/usr/bin/ssh", configPath: "/tmp/cfg", run });
    expect(calls).toEqual([["-G", "-F", "/tmp/cfg", "--", "fake"]]);
    expect(resolved).toEqual({
      alias: "fake", hostname: "127.0.0.1", user: "tester", port: 2222, identityFiles: ["~/.ssh/a", "~/.ssh/b"],
      proxyJump: "jump@bastion", userKnownHostsFiles: ["/k1", "/k2"], strictHostKeyChecking: "ask",
    });
  });

  it("refuses an alias ssh would read as an option", async () => {
    const run: CommandRunner = async () => { throw new Error("must not run"); };
    await expect(resolveSshHost("-oProxyCommand=x", { ssh: "ssh", run })).rejects.toThrow(/not a host/u);
    expect(isSshAlias("a b")).toBe(false);
    expect(isSshAlias("site-a")).toBe(true);
  });

  it("surfaces ssh's error", async () => {
    const run: CommandRunner = async () => ({ stdout: "", stderr: "Can't open user config file /x\n", code: 255 });
    await expect(resolveSshHost("fake", { ssh: "ssh", configPath: "/x", run })).rejects.toThrow(/Can't open user config file/u);
  });

  it("parses the defaults of an alias the config does not name", () => {
    expect(parseSshG("other", "host other\nhostname other\nport 22\n")).toEqual({ alias: "other", hostname: "other", port: 22, identityFiles: [], userKnownHostsFiles: [] });
  });

  const ssh = (() => { try { return execFileSync("which", ["ssh"], { encoding: "utf8" }).trim() || undefined; } catch { return undefined; } })();
  it.skipIf(!ssh)("resolves an alias of a test config through the real ssh -G", async () => {
    const dir = await tempDir();
    const config = join(dir, "ssh_config");
    // Absolute paths only: ssh resolves a relative Include against the account's real home.
    await writeFile(config, `Host fake\n  HostName 127.0.0.1\n  Port 2222\n  User tester\n  IdentityFile ${join(dir, "key")}\n  UserKnownHostsFile ${join(dir, "known_hosts")}\n  StrictHostKeyChecking yes\n`);
    const resolved = await resolveSshHost("fake", { ssh: ssh!, configPath: config });
    expect(resolved).toMatchObject({ hostname: "127.0.0.1", port: 2222, user: "tester", identityFiles: [join(dir, "key")], userKnownHostsFiles: [join(dir, "known_hosts")], strictHostKeyChecking: "true" });
  });
});

describe("parseManualTarget", () => {
  it("reads user@host:port with a separate path", () => {
    expect(parseManualTarget("deploy@example.com:2222", "/var/www")).toEqual({ target: { protocol: "sftp", username: "deploy", host: "example.com", port: 2222, remotePath: "/var/www" } });
    expect(parseManualTarget("example.com", "~/site").target).toEqual({ protocol: "sftp", host: "example.com", port: 22, remotePath: "~/site" });
  });

  it("reads URLs, scp style and IPv6", () => {
    expect(parseManualTarget("ftp://web@ftp.example.com/htdocs").target).toEqual({ protocol: "ftp", username: "web", host: "ftp.example.com", port: 21, remotePath: "/htdocs" });
    expect(parseManualTarget("sftp://u@[::1]:2200/srv").target).toEqual({ protocol: "sftp", username: "u", host: "::1", port: 2200, remotePath: "/srv" });
    expect(parseManualTarget("u@host:/srv/app").target).toEqual({ protocol: "sftp", username: "u", host: "host", port: 22, remotePath: "/srv/app" });
    expect(parseManualTarget("[fe80::1]", "/x").target?.host).toBe("fe80::1");
  });

  it("explains what is wrong", () => {
    expect(parseManualTarget("", "/x").error).toMatch(/host/u);
    expect(parseManualTarget("-oProxyCommand=x", "/x").error).toMatch(/host/u);
    expect(parseManualTarget("h:99999", "/x").error).toMatch(/port/u);
    expect(parseManualTarget("h:22").error).toMatch(/folder/u);
    expect(parseManualTarget("h", "relative").error).toMatch(/absolute/u);
    expect(parseManualTarget("-u@h", "/x").error).toMatch(/user/u);
  });
});
