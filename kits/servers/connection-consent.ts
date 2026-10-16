import { createHash } from "node:crypto";
import { HostCommandError } from "tau/host-extension";
import type { PromptAsker } from "./askpass.js";
import type { SftpJsonTarget } from "./sftp-json.js";

/** Only settings that change where or how credentials are used invalidate a grant. */
export function connectionFingerprint(target: SftpJsonTarget): string {
  const { protocol, host, port, username, remotePath, context, password, passphrase, privateKeyPath, agent, hop, sshConfigPath, knownHostsPath, secure, secureOptions, interactiveAuth } = target;
  return createHash("sha256").update(JSON.stringify({ protocol, host, port, username, remotePath, context, password, passphrase, privateKeyPath, agent, hop, sshConfigPath, knownHostsPath, secure, secureOptions, interactiveAuth })).digest("hex");
}

export interface ConnectionGrants {
  read(workspace: string, target: SftpJsonTarget): Promise<string | undefined>;
  write(workspace: string, target: SftpJsonTarget, fingerprint: string): Promise<void>;
}

/** One durable grant per project's effective connection, shared by both transports. */
export class ConnectionConsent {
  private readonly approved = new Map<string, string>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly prompts: PromptAsker, private readonly grants?: ConnectionGrants) {}

  allow(workspace: string, target: SftpJsonTarget): void {
    this.approved.set(`${workspace}\0${target.id}`, connectionFingerprint(target));
  }

  async grant(workspace: string, target: SftpJsonTarget): Promise<void> {
    await this.grants?.write(workspace, target, connectionFingerprint(target));
    this.allow(workspace, target);
  }

  async approve(workspace: string, target: SftpJsonTarget): Promise<SftpJsonTarget> {
    const snapshot = structuredClone(target);
    const fingerprint = connectionFingerprint(snapshot);
    const key = `${workspace}\0${snapshot.id}`;
    if (this.approved.get(key) === fingerprint) return snapshot;
    if (await this.grants?.read(workspace, snapshot) === fingerprint) { this.allow(workspace, snapshot); return snapshot; }
    const requestKey = `${key}\0${fingerprint}`;
    let pending = this.pending.get(requestKey);
    if (!pending) {
      pending = this.ask(workspace, snapshot).then(() => this.grant(workspace, snapshot))
        .finally(() => { this.pending.delete(requestKey); });
      this.pending.set(requestKey, pending);
    }
    await pending;
    return snapshot;
  }

  private async ask(workspace: string, target: SftpJsonTarget): Promise<void> {
    const answer = await this.prompts.ask({
      kind: "confirm",
      title: "Connect to the server from this project?",
      message: `${workspace}\n\nAllow Tau to use this server for this project? Tau remembers your choice on this machine and asks again if the connection settings change.`,
      detail: [
        `${target.protocol === "sftp" ? "SSH" : target.secure ? "FTPS" : "FTP"}: ${target.username ? `${target.username}@` : ""}${target.host}:${target.port}`,
        `Folder: ${target.remotePath}`,
        ...(target.protocol === "sftp" ? [
          `SSH key: ${target.privateKeyPath ?? "from SSH configuration"}`,
          `SSH agent: ${target.agent ?? "from SSH configuration"}`,
          `Jump servers: ${target.hop?.map((hop) => `${hop.username ? `${hop.username}@` : ""}${hop.host}:${hop.port ?? 22}`).join(", ") || "none"}`,
          "SSH host keys are always verified.",
        ] : []),
        ...(target.password?.command ? [`Password command: ${target.password.command}`] : []),
        ...(target.passphrase?.command ? [`Passphrase command: ${target.passphrase.command}`] : []),
      ].join("\n"),
      confirmLabel: "Connect",
      cancelLabel: "Cancel",
    });
    if (answer.action !== "confirm") throw new HostCommandError("The server connection was not approved.");
  }
}
