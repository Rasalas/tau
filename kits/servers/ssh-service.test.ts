import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HostCommandCall, HostExtensionCommandHandler, HostExtensionContext, HostExtensionServices, HostThreadLifecycle } from "tau/host-extension";
import { ASKPASS_ANSWER_COMMAND, ASKPASS_QUESTION_EVENT, type AskpassQuestion } from "./askpass-protocol";
import { findSftpServer, startFakeSshServer } from "./fixtures/fake-ssh-server.mjs";
import { hasCommand } from "./fixtures/run-command";
import { paths, readCalls, TEST_PASSWORD } from "./fixtures/servers-test-env.mjs";
import { decodeClientTarget, ServerSsh } from "./ssh-service";

const ready = hasCommand("ssh") && Boolean(findSftpServer()) && process.platform !== "win32";

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
  const events: Array<{ name: string; payload: unknown }> = [];
  const lifecycles: HostThreadLifecycle[] = [];
  const listeners = new Set<(event: { name: string; payload: unknown }) => void>();
  const services = {
    stateDir,
    findCommand: (name: string) => (name === "ssh" ? "ssh" : undefined),
    noteSubprocess: () => undefined,
    knownWorkspacePath: async (path: string) => path,
    registerThreadLifecycle: (lifecycle: HostThreadLifecycle) => { lifecycles.push(lifecycle); return () => undefined; },
  } as unknown as HostExtensionServices;
  const context = {
    id: "tau.servers",
    services,
    registerCommand: (name: string, handler: HostExtensionCommandHandler) => { commands.set(name, handler); return () => undefined; },
    emit: (name: string, payload: unknown) => {
      const event = { name, payload };
      events.push(event);
      for (const listener of listeners) listener(event);
    },
  } as unknown as HostExtensionContext;
  const call = (name: string, input?: unknown) => Promise.resolve(commands.get(name)!(input, { owner: true } as HostCommandCall));
  return { context, call, events, lifecycles, listeners };
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
    const { context, call, lifecycles, listeners } = fakeContext(join(dir, "state"));
    const ssh = new ServerSsh(context, { controlRoot });
    ssh.register();
    // What a window does: answer each question as it arrives.
    listeners.add(({ name, payload }) => {
      if (name !== ASKPASS_QUESTION_EVENT) return;
      const question = payload as AskpassQuestion;
      void call(ASKPASS_ANSWER_COMMAND, { id: question.id, answer: question.kind === "host-key" ? "yes" : TEST_PASSWORD });
    });
    const site = realpathSync(join(paths(dir).root, "site"));
    const target = { id: "site", alias: "fake-password", remotePath: site };
    try {
      const state = await call("ssh-connect", { cwd: "/project", target }) as { root: string; caps: { exec: boolean } };
      expect(state.root).toBe(site);
      expect(state.caps.exec).toBe(true);
      const entries = await call("ssh-list", { cwd: "/project", target, path: "" }) as Array<{ name: string }>;
      expect(entries.map((entry) => entry.name)).toContain("index.php");
      await expect(call("ssh-list", { cwd: "/project", target, path: "/etc" })).rejects.toThrow(/outside/u);
      await expect(call("ssh-list", { cwd: "/project", target, path: "missing" })).rejects.toMatchObject({ name: "HostCommandError" });
      await expect(call("ssh-connect", { cwd: "/project", target: { id: "bad", alias: "-oProxyCommand=x", remotePath: "/" } })).rejects.toMatchObject({ name: "HostCommandError" });
      expect(readCalls(dir).filter((entry) => entry.event === "authenticated")).toHaveLength(1);
      await lifecycles[0]!.afterWorkspaceClose!("/project", "switch");
      // Closed with the project: the next call logs in again.
      await call("ssh-list", { cwd: "/project", target, path: "" });
      expect(readCalls(dir).filter((entry) => entry.event === "authenticated")).toHaveLength(2);
    } finally {
      await ssh.dispose();
    }
  });
});
