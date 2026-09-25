import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanEnv, hasCommand, runCommand } from "./run-command";
import { isLoopback, paths, prepareServersDir, renderSshConfig, serversInstanceEnv, serversStateDir } from "./servers-test-env.mjs";

describe("the servers test folder", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tau-servers-env-"));
    prepareServersDir(dir);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("holds the test keys, private and unchanged by a second run", () => {
    const key = readFileSync(paths(dir).key, "utf8");
    expect(key).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(statSync(paths(dir).key).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    prepareServersDir(dir);
    expect(readFileSync(paths(dir).key, "utf8")).toBe(key);
    expect(readFileSync(`${paths(dir).passphraseKey}.pub`, "utf8")).toMatch(/^ssh-ed25519 /u);
  });

  it("has a fake site and a fake HOME with tmp/", () => {
    expect(readFileSync(join(paths(dir).root, "site", "index.php"), "utf8")).toContain("fake site");
    expect(statSync(join(paths(dir).home, "tmp")).isDirectory()).toBe(true);
  });

  it("names the fake host only once a server gave it a port", () => {
    expect(renderSshConfig(dir)).not.toContain("Host fake");
    expect(renderSshConfig(dir, { sshPort: 2222 })).toContain("Host fake\n  HostName 127.0.0.1\n  Port 2222\n  User tester");
  });

  it("quotes paths and escapes ssh's % tokens", () => {
    expect(renderSshConfig("/tmp/a b%c")).toContain('IdentityFile "/tmp/a b%%c/id_ed25519"');
  });

  it.skipIf(!hasCommand("ssh"))("is read by ssh as a config that reaches none of the user's files", async () => {
    const config = renderSshConfig(dir, { sshPort: 2222 });
    expect(config).toContain("GlobalKnownHostsFile /dev/null");
    const resolved = await runCommand("ssh", ["-G", "-F", paths(dir).sshConfig, "fake"], { env: cleanEnv() });
    expect(resolved.code, resolved.stderr).toBe(0);
    const option = (name: string) => resolved.stdout.split("\n").filter((line) => line.startsWith(`${name} `)).map((line) => line.slice(name.length + 1));
    expect(option("identitiesonly")).toEqual(["yes"]);
    expect(option("identityfile")).toEqual([paths(dir).key]);
    expect(option("identityagent")).toEqual([paths(dir).agentSocket]);
    expect(option("userknownhostsfile")).toEqual([paths(dir).knownHosts]);
    expect(option("globalknownhostsfile")).toEqual(["/dev/null"]);
    expect(option("forwardagent")).toEqual(["no"]);
  });

  it("gives an instance the stubs, the test config and agent, and the loopback guard", () => {
    const env = serversInstanceEnv(dir);
    expect(env).toEqual({
      FAKE_SERVERS_STATE: dir,
      TAU_SERVERS_SECURITY_COMMAND: join(import.meta.dirname, "fake-security.mjs"),
      TAU_SERVERS_SECRET_TOOL_COMMAND: join(import.meta.dirname, "fake-secret-tool.mjs"),
      TAU_SERVERS_SSH_CONFIG: paths(dir).sshConfig,
      TAU_SERVERS_LOOPBACK_ONLY: "1",
      SSH_AUTH_SOCK: paths(dir).agentSocket,
    });
  });

  it("finds its folder from the instance's variables", () => {
    expect(serversStateDir({ FAKE_SERVERS_STATE: "/x/servers" })).toBe("/x/servers");
    expect(serversStateDir({ TAU_USER_DATA: "/x/.tau-dev/userdata" })).toBe("/x/.tau-dev/servers");
    expect(serversStateDir({})).toBeUndefined();
  });

  it("knows loopback", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "::1", "localhost", "::ffff:127.0.0.1"]) expect(isLoopback(host), host).toBe(true);
    for (const host of ["0.0.0.0", "192.168.1.2", "example.com", "::"]) expect(isLoopback(host), host).toBe(false);
  });

  it("keeps the test run away from the developer's agent", () => {
    expect(process.env.SSH_AUTH_SOCK).toBeUndefined();
    expect(process.env.TAU_SERVERS_LOOPBACK_ONLY).toBe("1");
  });
});

describe("readableKeyPair", () => {
  it("only hands out keys ssh2 can read back, with and without a passphrase", async () => {
    const { canReadKey, readableKeyPair } = await import("./servers-test-env.mjs");
    for (let index = 0; index < 400; index += 1) expect(canReadKey(readableKeyPair({ comment: "probe" }).private)).toBe(true);
    const locked = readableKeyPair({ comment: "probe", passphrase: "pw", cipher: "aes256-ctr" });
    expect(canReadKey(locked.private, "pw")).toBe(true);
  });
});
