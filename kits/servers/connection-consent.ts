import { createHash } from "node:crypto";
import { HostCommandError } from "tau/host-extension";
import type { PromptAsker } from "./askpass.js";
import type { SftpJsonTarget } from "./sftp-json.js";

/** Repository connection settings need an explicit grant in each host session. */
export class ConnectionConsent {
  private readonly approved = new Map<string, string>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(private readonly prompts: PromptAsker) {}

  allow(workspace: string, target: SftpJsonTarget): void {
    this.approved.set(`${workspace}\0${target.id}`, createHash("sha256").update(JSON.stringify(target)).digest("hex"));
  }

  async approve(workspace: string, target: SftpJsonTarget): Promise<SftpJsonTarget> {
    const snapshot = structuredClone(target);
    const fingerprint = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    const key = `${workspace}\0${snapshot.id}`;
    if (this.approved.get(key) === fingerprint) return snapshot;
    const requestKey = `${key}\0${fingerprint}`;
    let pending = this.pending.get(requestKey);
    if (!pending) {
      pending = this.ask(workspace, snapshot).then(() => { this.approved.set(key, fingerprint); })
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
      message: `${workspace}\n\nThe project's sftp.json chooses this address and login settings. Allow this connection for this session? Tau will ask again if the settings change.`,
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
