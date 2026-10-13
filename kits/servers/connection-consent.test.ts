import { afterEach, expect, it, vi } from "vitest";
import type { HostExtensionContext } from "tau/host-extension";
import type { PromptAsker } from "./askpass.js";
import type { SftpJsonTarget } from "./sftp-json.js";
import { ServerFtp } from "./ftp-service.js";
import type { ServerCredentials } from "./credentials.js";
import type { ServersStore } from "./store.js";
import { FtpConnections, type FtpTransport } from "./transport-ftp.js";
import { sshBaseArgs } from "./ssh-target.js";
import { ServerSsh, sshTargetOf } from "./ssh-service.js";
import { SshConnections, type SshTransport } from "./transport-ssh.js";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const target = { id: "site", protocol: "sftp", host: "site.example.com", port: 22, username: "deploy", remotePath: "/srv/site", hop: [], hostVerification: false, privateKeyPath: "keys/deploy", usable: true } as unknown as SftpJsonTarget;
  const connect = vi.fn(async () => undefined);
  const get = vi.spyOn(SshConnections.prototype, "get").mockReturnValue({ connect, label: "site" } as unknown as SshTransport);
  const ask = vi.fn<PromptAsker["ask"]>(async () => ({ action: "confirm" }));
  const context = { services: { stateDir: "/tmp/unused-consent-state", knownWorkspacePath: async (path: string) => path, log: () => undefined } } as unknown as HostExtensionContext;
  const ssh = new ServerSsh(context, { prompts: { ask }, lookupTarget: async () => target });
  const input = { cwd: "/project", targetId: "site" };
  return { target, connect, get, ask, ssh, input };
}

it("requires consent before a repository target connects and asks again when it changes", async () => {
  const { target, connect, ask, ssh, input } = fixture();
  let answer!: (value: { action: "confirm" }) => void;
  ask.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
  const pending = ssh.transport(input);
  await vi.waitFor(() => expect(ask).toHaveBeenCalledOnce());
  expect(connect).not.toHaveBeenCalled();
  expect(ask.mock.calls[0]![0]).toMatchObject({ kind: "confirm", detail: expect.stringContaining("keys/deploy") });
  answer({ action: "confirm" });
  await pending;
  await ssh.transport(input);
  expect(ask).toHaveBeenCalledOnce();
  target.hop = [{ host: "jump.example.com" }];
  await ssh.transport(input);
  expect(ask).toHaveBeenCalledTimes(2);
  await ssh.transport({ ...input, cwd: "/another-project" });
  expect(ask).toHaveBeenCalledTimes(3);
});

it("a declined repository target never creates a transport", async () => {
  const { get, ask, ssh, input } = fixture();
  ask.mockResolvedValue({ action: "cancel" });
  await expect(ssh.transport(input)).rejects.toThrow(/not approved/u);
  expect(get).not.toHaveBeenCalled();
});

it("verifies SSH host keys even when the repository disables them", () => {
  const { target } = fixture();
  const approved = sshTargetOf(target);
  expect(approved.hostVerification).toBe(true);
  expect(sshBaseArgs(approved).args).toContain("StrictHostKeyChecking=ask");
});

it("requires repository consent for FTP before creating a transport", async () => {
  const { target, ask, input } = fixture();
  target.protocol = "ftp";
  const get = vi.spyOn(FtpConnections.prototype, "get").mockReturnValue({ connect: vi.fn(async () => undefined) } as unknown as FtpTransport);
  const context = { services: { knownWorkspacePath: async (path: string) => path } } as unknown as HostExtensionContext;
  const ftp = new ServerFtp(context, {
    prompts: { ask }, credentials: {} as ServerCredentials, store: {} as ServersStore,
    lookupTarget: async () => ({ project: { root: input.cwd, workspaceId: "ws" }, target }),
  });
  ask.mockResolvedValueOnce({ action: "cancel" });
  await expect(ftp.transport(input)).rejects.toThrow(/not approved/u);
  expect(get).not.toHaveBeenCalled();
  await ftp.transport(input);
  expect(get).toHaveBeenCalledOnce();
  expect(ask).toHaveBeenCalledTimes(2);
});
