import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findSftpServer, startFakeSshServer } from "./fake-ssh-server.mjs";
import { cleanEnv, hasCommand, runCommand } from "./run-command";
import { paths, readCalls, startTestSshAgent } from "./servers-test-env.mjs";

type Started = Awaited<ReturnType<typeof startFakeSshServer>>;

const hasSsh = hasCommand("ssh");
const sftpServer = findSftpServer();

function ssh(dir: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string) {
  return runCommand("ssh", ["-F", paths(dir).sshConfig, ...args], { env: cleanEnv(env), input });
}

function askpass(dir: string, answers: Record<string, string>) {
  const script = join(dir, "askpass.sh");
  const cases = Object.entries(answers).map(([prompt, answer]) => `  *'${prompt}'*) printf '%s\\n' '${answer}' ;;`).join("\n");
  writeFileSync(script, `#!/bin/sh\ncase "$1" in\n${cases}\n  *) exit 1 ;;\nesac\n`);
  chmodSync(script, 0o700);
  return { SSH_ASKPASS: script, SSH_ASKPASS_REQUIRE: "force" };
}

describe.skipIf(!hasSsh)("the fake SSH server", () => {
  let dir: string;
  let server: Started;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "tau-fake-ssh-"));
    server = await startFakeSshServer({ dir, trustHostKey: true });
  });

  afterAll(async () => {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("listens on loopback only", async () => {
    expect(server.host).toBe("127.0.0.1");
    await expect(startFakeSshServer({ dir, host: "0.0.0.0" })).rejects.toThrow(/loopback only/u);
  });

  it("runs a command with the test key, in the fake HOME, and logs the call", async () => {
    const result = await ssh(dir, ["-o", "BatchMode=yes", "fake", "echo ok; echo \"$HOME\""]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(`ok\n${paths(dir).home}\n`);
    const calls = readCalls(dir);
    expect(calls).toContainEqual(expect.objectContaining({ tool: "ssh", event: "auth", method: "publickey", ok: true, user: "tester" }));
    expect(calls).toContainEqual(expect.objectContaining({ event: "exec", command: "echo ok; echo \"$HOME\"" }));
    expect(calls).toContainEqual(expect.objectContaining({ event: "exit", command: "echo ok; echo \"$HOME\"", code: 0 }));
  });

  it("pins the fresh host key in the test known_hosts, nowhere else", () => {
    expect(readFileSync(paths(dir).knownHosts, "utf8")).toContain(server.knownHostsLine);
    expect(server.fingerprint).toMatch(/^SHA256:/u);
  });

  it("passes on the exit status", async () => {
    const result = await ssh(dir, ["-o", "BatchMode=yes", "fake", "exit 3"]);
    expect(result.code).toBe(3);
  });

  it("takes the password through SSH_ASKPASS and never logs it", async () => {
    const result = await ssh(dir, ["fake-password", "echo pw"], askpass(dir, { Password: "test" }));
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe("pw\n");
    const log = readFileSync(paths(dir).calls, "utf8");
    expect(log).not.toContain("\"password\":");
  });

  it("refuses a wrong password", async () => {
    const result = await ssh(dir, ["-o", "NumberOfPasswordPrompts=1", "fake-password", "echo no"], askpass(dir, { Password: "wrong" }));
    expect(result.code).toBe(255);
    expect(readCalls(dir)).toContainEqual(expect.objectContaining({ event: "auth", ok: false }));
  });

  it("signs through the test ssh-agent, stopped by its PID afterwards", async () => {
    const agent = await startTestSshAgent(dir);
    try {
      expect(agent.owned).toBe(true);
      expect(agent.socket).toBe(paths(dir).agentSocket);
      // Only the public half on disk for ssh: the agent has to sign.
      const result = await ssh(dir, ["-o", "BatchMode=yes", "-o", `IdentityFile=${paths(dir).key}.pub`, "fake", "echo agent"]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe("agent\n");
      const again = await startTestSshAgent(dir);
      expect(again.pid).toBe(agent.pid);
    } finally {
      agent.stop();
      await agent.exited;
    }
    expect(() => process.kill(agent.pid as number, 0)).toThrow();
  });

  it("forwards to loopback only (ProxyJump's direct-tcpip)", async () => {
    const target: Server = createServer((socket) => socket.end("hello from loopback"));
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    try {
      const port = (target.address() as { port: number }).port;
      const inside = await ssh(dir, ["-o", "BatchMode=yes", "-W", `127.0.0.1:${port}`, "fake"]);
      expect(inside.stdout).toBe("hello from loopback");
      const outside = await ssh(dir, ["-o", "BatchMode=yes", "-W", "192.0.2.1:9", "fake"]);
      expect(outside.code).toBe(255);
      expect(readCalls(dir)).toContainEqual(expect.objectContaining({ event: "direct-tcpip", to: "192.0.2.1:9", ok: false }));
    } finally {
      await new Promise((resolve) => target.close(resolve));
    }
  });

  it.skipIf(!sftpServer)("serves SFTP from the fake root and logs every operation", async () => {
    const local = join(dir, "upload.txt");
    writeFileSync(local, "uploaded\n");
    const batch = [`put ${local} site/uploaded.txt`, "ls site", `get site/index.php ${join(dir, "downloaded.php")}`, "rm site/uploaded.txt", "ls /"].join("\n");
    const result = await runCommand("sftp", ["-F", paths(dir).sshConfig, "-o", "BatchMode=yes", "-b", "-", "fake"], { env: cleanEnv(), input: `${batch}\n` });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("site/uploaded.txt");
    expect(readFileSync(join(dir, "downloaded.php"), "utf8")).toContain("fake site");
    expect(existsSync(join(paths(dir).root, "site", "uploaded.txt"))).toBe(false);
    const operations = readCalls(dir).filter((call) => call.event === "sftp-op");
    expect(operations.some((call) => /^open ".*site\/uploaded\.txt" flags WRITE/u.test(call.line))).toBe(true);
    expect(operations.some((call) => /^remove name ".*site\/uploaded\.txt"/u.test(call.line))).toBe(true);
    // Only `ls /` left the fake root.
    expect(operations.filter((call) => call.outside).map((call) => call.line)).toEqual(['opendir "/"', 'closedir "/"']);
  });
});

describe.skipIf(!hasSsh)("the fake SSH server with a one-time code", () => {
  let dir: string;
  let server: Started;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "tau-fake-ssh-otp-"));
    server = await startFakeSshServer({ dir, trustHostKey: true, otp: "424242" });
  });

  afterAll(async () => {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("asks for the code after the key", async () => {
    const result = await ssh(dir, ["fake", "echo in"], askpass(dir, { "Verification code": "424242" }));
    expect(result.code, result.stderr).toBe(0);
    const auth = readCalls(dir).filter((call) => call.event === "auth" && call.ok);
    expect(auth).toContainEqual(expect.objectContaining({ method: "publickey", partial: true }));
    expect(auth).toContainEqual(expect.objectContaining({ method: "keyboard-interactive", prompt: "otp" }));
  });

  it("stays shut without it", async () => {
    const result = await ssh(dir, ["-o", "BatchMode=yes", "fake", "echo in"]);
    expect(result.code).toBe(255);
  });
});
