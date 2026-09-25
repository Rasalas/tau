import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import type { PromptAsker } from "./askpass.js";
import { loginAccount, type CredentialProject, type ServerCredentials } from "./credentials.js";
import type { SftpJsonTarget } from "./sftp-json.js";
import type { ServersStore, TargetKey } from "./store.js";
import { readTargetFile, updateTargetFile, type TargetFile } from "./target-settings.js";
import { FtpConnections, FtpTransport, type FtpCertificate } from "./transport-ftp.js";

/**
 * FTP connections of the open projects. Before a password goes out, plain FTP
 * needs the user's yes for that login, and a TLS certificate Node cannot
 * verify needs the user's trust; both are kept in the target's `target.json`.
 */

export interface ServerFtpOptions {
  prompts: PromptAsker;
  credentials: ServerCredentials;
  store: ServersStore;
  lookupTarget(cwd: string, targetId: string): Promise<{ project: CredentialProject; target: SftpJsonTarget }>;
  env?: NodeJS.ProcessEnv;
}

/** `target.json`'s `ftp`: the login allowed in plain text, the certificates trusted per `host:port`. */
export interface FtpTrust {
  plain?: string;
  certificates?: Record<string, string>;
}

export function ftpTrustOf(file: TargetFile): FtpTrust {
  const raw = file.ftp;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const { plain, certificates } = raw as Record<string, unknown>;
  const pins = certificates && typeof certificates === "object" && !Array.isArray(certificates)
    ? Object.fromEntries(Object.entries(certificates).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : undefined;
  return { ...(typeof plain === "string" ? { plain } : {}), ...(pins ? { certificates: pins } : {}) };
}

const updateTrust = (store: ServersStore, key: TargetKey, change: (trust: FtpTrust) => FtpTrust) =>
  updateTargetFile(store, key, (file) => ({ ...file, ftp: change(ftpTrustOf(file)) }));

export class ServerFtp {
  readonly connections = new FtpConnections();
  private unhook: (() => void) | undefined;

  constructor(private readonly context: HostExtensionContext, private readonly options: ServerFtpOptions) {}

  /** The connected transport of a project's FTP target. */
  async transport(input: { cwd: string; targetId: string }): Promise<FtpTransport> {
    const workspace = await this.context.services.knownWorkspacePath(input.cwd);
    const { project, target } = await this.options.lookupTarget(workspace, input.targetId);
    if (target.protocol !== "ftp") throw new HostCommandError(`${target.name ?? target.host} is not an FTP server.`);
    if (!target.usable) throw new HostCommandError(`${target.name ?? target.host} cannot be reached as sftp.json names it.`);
    const transport = this.connections.get(workspace, target, () => this.create(project, target));
    try {
      await transport.connect();
    } catch (error) {
      // A refused login or certificate is an answer about the server, not a broken command.
      throw error instanceof Error ? new HostCommandError(error.message) : error;
    }
    return transport;
  }

  private create(project: CredentialProject, target: SftpJsonTarget): FtpTransport {
    const key: TargetKey = { workspaceId: project.workspaceId, targetId: target.id };
    const { prompts, credentials, store } = this.options;
    const label = target.name ?? target.host;
    const login = loginAccount(target);
    return new FtpTransport(target, {
      ...(this.options.env ? { env: this.options.env } : {}),
      attempt: () => credentials.attempt(project, target),
      allowPlain: async () => {
        if (ftpTrustOf(await readTargetFile(store, key)).plain === login) return true;
        const answer = await prompts.ask({
          kind: "confirm",
          title: "Send the password unencrypted?",
          message: `${label} (${target.host}:${target.port}) is plain FTP: the password and every file cross the network unencrypted, and anyone on the way can read them. Tau asks once for this server.`,
          confirmLabel: "Connect unencrypted",
          cancelLabel: "Cancel",
        });
        if (answer.action !== "confirm") return false;
        await updateTrust(store, key, (trust) => ({ ...trust, plain: login }));
        this.context.services.log("servers.ftp", `plain FTP allowed for ${login}`);
        return true;
      },
      trustCertificate: async (certificate) => {
        const known = ftpTrustOf(await readTargetFile(store, key)).certificates?.[certificate.address];
        if (known === certificate.sha256) return true;
        const answer = await prompts.ask(certificatePrompt(label, certificate, Boolean(known)));
        if (answer.action !== "confirm") return false;
        await updateTrust(store, key, (trust) => ({ ...trust, certificates: { ...trust.certificates, [certificate.address]: certificate.sha256 } }));
        this.context.services.log("servers.ftp", `certificate trusted for ${certificate.address}`);
        return true;
      },
    });
  }

  register(): void {
    this.unhook = this.context.services.registerThreadLifecycle({
      afterWorkspaceClose: (cwd) => this.connections.closeWorkspace(cwd),
    });
  }

  async dispose(): Promise<void> {
    this.unhook?.();
    await this.connections.closeAll();
  }
}

export function certificatePrompt(label: string, certificate: FtpCertificate, changed: boolean) {
  const issued = [certificate.subject ? `Issued to ${certificate.subject}` : "", certificate.issuer ? `by ${certificate.issuer}` : ""].filter(Boolean).join(" ");
  return {
    kind: "confirm" as const,
    title: changed ? "The server's certificate changed" : "Trust this server's certificate?",
    message: changed
      ? `The TLS certificate of ${label} (${certificate.address}) is not the one you trusted before. A host renewing it looks like this, and so does someone in between. Compare the fingerprint with your host's before you trust it.`
      : `Tau cannot verify the TLS certificate of ${label} (${certificate.address}): ${certificate.reason}. Compare the fingerprint with your host's before you trust it.`,
    detail: [`SHA-256 ${certificate.sha256}`, issued, certificate.validTo ? `Valid until ${certificate.validTo}` : ""].filter(Boolean).join("\n"),
    confirmLabel: "Trust and connect",
    cancelLabel: "Cancel",
  };
}
