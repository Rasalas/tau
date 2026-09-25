import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HostCommandCall, HostExtensionCommandHandler, HostExtensionContext, HostExtensionServices, HostThreadLifecycle } from "tau/host-extension";
import type { AskpassTarget, CredentialSource, LoginOutcome } from "./askpass";
import { ServerPrompts } from "./prompts";
import { SERVERS_PROMPTS_EVENT, type ServerPrompt } from "./protocol";
import type { SftpJsonTarget } from "./sftp-json";
import { findSftpServer, startFakeSshServer } from "./fixtures/fake-ssh-server.mjs";
import { hasCommand } from "./fixtures/run-command";
import { paths, readCalls, TEST_PASSWORD } from "./fixtures/servers-test-env.mjs";
import { decodeClientTarget, ServerSsh, sshTargetOf } from "./ssh-service";

const ready = hasCommand("ssh") && Boolean(findSftpServer()) && process.platform !== "win32";

describe("sshTargetOf", () => {
  it("leaves out the local paths sftp.json may not choose: an ssh config and a known_hosts file", () => {
    const target = {
      id: "sftp-site", protocol: "sftp", host: "127.0.0.1", port: 22, username: "u", remotePath: "/srv", name: "site",
      sshConfigPath: "evil_config", knownHostsPath: "/home/me/.bashrc", privateKeyPath: "~/.ssh/id", hop: [], hostVerification: true,
      connectTimeout: 10_000, concurrency: 4, usable: true,
    } as unknown as SftpJsonTarget;
    const ssh = sshTargetOf(target);
    expect(ssh).toMatchObject({ id: "sftp-site", host: "127.0.0.1", port: 22, username: "u", privateKeyPath: "~/.ssh/id" });
    expect(ssh).not.toHaveProperty("sshConfigPath");
    expect(ssh).not.toHaveProperty("knownHostsPath");
    expect(() => sshTargetOf({ ...target, protocol: "ftp" } as SftpJsonTarget)).toThrow(/FTP/u);
  });
});

describe("decodeClientTarget", () => {
  it("takes the address from a client and never a local path", () => {
    expect(decodeClientTarget({
      id: "site", alias: "fake", remotePath: "/srv", port: 22, username: "u",
      privateKeyPath: "/k", sshConfigPath: "/evil", agent: "/a", knownHostsPath: "/kh",
    })).toEqual({ id: "site", alias: "fake", host: "fake", remotePath: "/srv", port: 22, username: "u" });
    expect(() => decodeClientTarget({ id: "../x", host: "h", remotePath: "/" })).toThrow(/Name the target/u);
    expect(() => decodeClientTarget({ id: "t", remotePath: "/" })).toThrow(/host/u);
    expect(() => decodeClientTarget({ id: "t", host: "h" })).toThrow(/folder/u);
  });
});

function fakeContext(stateDir: string) {
  const commands = new Map<string, HostExtensionCommandHandler>();
  const lifecycles: HostThreadLifecycle[] = [];
  const services = {
    stateDir,
    findCommand: (name: string) => (name === "ssh" ? "ssh" : undefined),
    noteSubprocess: () => undefined,
    log: () => undefined,
    knownWorkspacePath: async (path: string) => path,
    registerThreadLifecycle: (lifecycle: HostThreadLifecycle) => { lifecycles.push(lifecycle); return () => undefined; },
  } as unknown as HostExtensionServices;
  const context = {
    id: "tau.servers",
    services,
    registerCommand: (name: string, handler: HostExtensionCommandHandler) => { commands.set(name, handler); return () => undefined; },
    emit: () => undefined,
  } as unknown as HostExtensionContext;
  const call = (name: string, input?: unknown) => Promise.resolve(commands.get(name)!(input, { owner: true } as HostCommandCall));
  return { context, call, lifecycles };
}

describe.skipIf(!ready)("ServerSsh against the fake server", () => {
  let dir: string;
  let controlRoot: string;
  let server: Awaited<ReturnType<typeof startFakeSshServer>>;
  const saved = process.env.TAU_SERVERS_SSH_CONFIG;

  beforeAll(async () => {
    dir = mkdtempSync("/tmp/tau-svc-t-");
    controlRoot = mkdtempSync("/tmp/tau-ctl-");
    server = await startFakeSshServer({ dir });
    process.env.TAU_SERVERS_SSH_CONFIG = paths(dir).sshConfig;
  });

  afterAll(async () => {
    if (saved === undefined) delete process.env.TAU_SERVERS_SSH_CONFIG;
    else process.env.TAU_SERVERS_SSH_CONFIG = saved;
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(controlRoot, { recursive: true, force: true });
  });

  it("asks the windows for the host key and the password, connects, and lets go when the project closes", async () => {
    const { context, call, lifecycles } = fakeContext(join(dir, "state"));
    // What a window does: answer each question as it arrives.
    const prompts: ServerPrompts = new ServerPrompts((event, payload) => {
      if (event !== SERVERS_PROMPTS_EVENT) return;
      for (const prompt of (payload as { prompts: ServerPrompt[] }).prompts) {
        queueMicrotask(() => prompts.answer(prompt.id, prompt.kind === "secret" ? { action: "confirm", value: TEST_PASSWORD } : { action: "confirm" }));
      }
    });
    const outcomes: Array<[AskpassTarget, LoginOutcome]> = [];
    const recorder: CredentialSource = { answer: async () => undefined, settled: (target, outcome) => { outcomes.push([target, outcome]); } };
    const site = realpathSync(join(paths(dir).root, "site"));
    const sftpJson = { id: "sftp-site", protocol: "sftp", host: "fake-password", port: server.port, username: "tester", remotePath: site, name: "site", hop: [], hostVerification: true, connectTimeout: 10_000, concurrency: 4, usable: true } as unknown as SftpJsonTarget;
    const ssh = new ServerSsh(context, { prompts, controlRoot, credentialSources: [recorder], lookupTarget: async (_cwd, id) => { if (id !== "sftp-site") throw new Error("unknown"); return sftpJson; } });
    ssh.register();
    const byId = { cwd: "/project", targetId: "sftp-site" };
    try {
      const state = await call("ssh-connect", byId) as { root: string; caps: { exec: boolean } };
      expect(state.root).toBe(site);
      expect(state.caps.exec).toBe(true);
      expect(outcomes).toEqual([[{ id: "sftp-site", label: "site", workspace: "/project" }, { ok: true }]]);
      const entries = await call("ssh-list", { ...byId, path: "" }) as Array<{ name: string }>;
      expect(entries.map((entry) => entry.name)).toContain("index.php");
      await expect(call("ssh-list", { ...byId, path: "/etc" })).rejects.toThrow(/outside/u);
      await expect(call("ssh-list", { ...byId, path: "missing" })).rejects.toMatchObject({ name: "HostCommandError" });
      await expect(call("ssh-connect", { cwd: "/project", target: { id: "bad", alias: "-oProxyCommand=x", remotePath: "/" } })).rejects.toMatchObject({ name: "HostCommandError" });
      expect(outcomes.at(-1)![1]).toMatchObject({ ok: false });
      expect(readCalls(dir).filter((entry) => entry.event === "authenticated")).toHaveLength(1);
      await lifecycles[0]!.afterWorkspaceClose!("/project", "switch");
      // Closed with the project: the next call logs in again.
      await call("ssh-list", { ...byId, path: "" });
      expect(readCalls(dir).filter((entry) => entry.event === "authenticated")).toHaveLength(2);
    } finally {
      prompts.dispose();
      await ssh.dispose();
    }
  });
});
