import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import { AskpassBridge, AskpassPrompts, type CredentialSource, type LoginOutcome, type PromptAsker } from "./askpass.js";
import { ServerPathError, type ServerEntry } from "./server-fs.js";
import { SftpError } from "./sftp-client.js";
import type { SftpJsonTarget } from "./sftp-json.js";
import type { SshTarget } from "./ssh-target.js";
import { isStoreSegment } from "./store.js";
import { SshConnectError, SshConnections, SshTransport } from "./transport-ssh.js";

export interface ServerSshOptions {
  /** The kit's dialogs; ssh's questions become some of them. */
  prompts: PromptAsker;
  /**
   * Asked before the dialog, in order: the credentials' keychain and command
   * source goes here. The dialog answers what they pass on.
   */
  credentialSources?: readonly CredentialSource[];
  /** A project's sftp.json target by its id. */
  lookupTarget?: (cwd: string, targetId: string) => Promise<SftpJsonTarget>;
  /** `/tmp` unless a test names its own. */
  controlRoot?: string;
}

/** What a connection reports: where it landed and what the server offers. */
export interface SshConnectState {
  root: string;
  scratch?: string;
  os?: string;
  caps: SshTransport["caps"];
}

/**
 * The address part of a target a client may name. Local paths (keys, configs,
 * known_hosts) come only from the project's own files, never from a client.
 */
export function decodeClientTarget(value: unknown): SshTarget {
  const input = (value ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof input[key] === "string" && input[key] ? input[key] as string : undefined);
  const id = text("id");
  const remotePath = text("remotePath");
  const alias = text("alias");
  const host = text("host") ?? alias;
  if (!id || !isStoreSegment(id)) throw new HostCommandError("Name the target.");
  if (!host) throw new HostCommandError("Name a host or an ssh alias.");
  if (!remotePath) throw new HostCommandError("Name the folder on the server.");
  const port = typeof input.port === "number" && Number.isInteger(input.port) && input.port > 0 && input.port < 65_536 ? input.port : undefined;
  const name = text("name");
  const username = text("username");
  return { id, host, remotePath, ...(alias ? { alias } : {}), ...(name ? { name } : {}), ...(username ? { username } : {}), ...(port ? { port } : {}) };
}

/**
 * An sftp.json target for ssh. Its `sshConfigPath` and `knownHostsPath` are
 * left out: the file is repo content, a config can run commands
 * (ProxyCommand, Match exec) and ssh writes to a known_hosts file.
 */
export function sshTargetOf(target: SftpJsonTarget): SshTarget {
  if (target.protocol !== "sftp") throw new HostCommandError(`${target.name ?? target.host} is an FTP server: no SSH login, no server commands.`);
  if (!target.usable) throw new HostCommandError(`${target.name ?? target.host} cannot be reached as sftp.json names it.`);
  return {
    id: target.id,
    host: target.host,
    port: target.port,
    remotePath: target.remotePath,
    hostVerification: target.hostVerification,
    connectTimeout: target.connectTimeout,
    concurrency: target.concurrency,
    ...(target.name ? { name: target.name } : {}),
    ...(target.username ? { username: target.username } : {}),
    ...(target.privateKeyPath ? { privateKeyPath: target.privateKeyPath } : {}),
    ...(target.agent ? { agent: target.agent } : {}),
    ...(target.hop.length ? { hop: target.hop.map(({ host, port, username }) => ({ host, ...(port ? { port } : {}), ...(username ? { username } : {}) })) } : {}),
  };
}

/** Where the connections of a project not made yet are kept; no project has this key. */
const DRAFT_WORKSPACE = "draft:";

/** SSH connections of the open projects and the askpass bridge behind them. */
export class ServerSsh {
  readonly askpass: AskpassBridge;
  readonly connections: SshConnections;
  private readonly sources: readonly CredentialSource[];
  private unhook: (() => void) | undefined;

  constructor(private readonly context: HostExtensionContext, private readonly options: ServerSshOptions) {
    const services = context.services;
    this.sources = [...(options.credentialSources ?? []), new AskpassPrompts(options.prompts)];
    this.askpass = new AskpassBridge({ stateDir: services.stateDir, sources: this.sources, ...(options.controlRoot ? { controlRoot: options.controlRoot } : {}) });
    this.connections = new SshConnections((target, workspace) => {
      const ssh = services.findCommand("ssh");
      if (!ssh) throw new HostCommandError("ssh is not on this machine's PATH.");
      return new SshTransport(target, {
        ssh, askpass: this.askpass, baseDir: workspace, workspace, onSpawn: () => services.noteSubprocess(),
        ...(options.controlRoot ? { controlRoot: options.controlRoot } : {}),
      });
    });
  }

  /** `{ cwd, targetId }` names an sftp.json target; `{ cwd, target }` an address. */
  private async resolve(input: unknown): Promise<{ workspace: string; target: SshTarget }> {
    const { cwd, targetId, target } = (input ?? {}) as { cwd?: unknown; targetId?: unknown; target?: unknown };
    if (typeof cwd !== "string" || !cwd) throw new HostCommandError("Open a project first.");
    const workspace = await this.context.services.knownWorkspacePath(cwd);
    if (typeof targetId === "string" && targetId) {
      if (!this.options.lookupTarget) throw new HostCommandError("This host reads no sftp.json targets.");
      return { workspace, target: sshTargetOf(await this.options.lookupTarget(workspace, targetId)) };
    }
    return { workspace, target: decodeClientTarget(target) };
  }

  /** The transport of a project's target; connected on first use. */
  async transport(input: unknown): Promise<SshTransport> {
    const { workspace, target } = await this.resolve(input);
    return this.connect(workspace, target);
  }

  /**
   * A connection for a project that does not exist yet: browsing a server and
   * sizing a folder before the download. The target is an address only.
   */
  draftTransport(target: SshTarget): Promise<SshTransport> {
    return this.connect(DRAFT_WORKSPACE, target);
  }

  closeDrafts(): Promise<void> {
    return this.connections.closeWorkspace(DRAFT_WORKSPACE);
  }

  private async connect(workspace: string, target: SshTarget): Promise<SshTransport> {
    const transport = this.connections.get(workspace, target);
    let outcome: LoginOutcome = { ok: true };
    try {
      await transport.connect();
    } catch (error) {
      outcome = { ok: false, message: error instanceof Error ? error.message : String(error) };
      // A failed login or a refused target is an answer about the server, not a broken command.
      throw error instanceof Error ? new HostCommandError(error.message) : error;
    } finally {
      const settled = { id: target.id, label: transport.label, workspace };
      await Promise.all(this.sources.map(async (source) => {
        try { await source.settled?.(settled, outcome); } catch (error) { this.context.services.log("servers.ssh", `a credential source failed after the login: ${(error as Error).message}`); }
      }));
    }
    return transport;
  }

  register(): void {
    const { context } = this;
    // `long`: a login may wait on the user's answer in a dialog.
    context.registerCommand("ssh-connect", async (input) => {
      const transport = await this.transport(input);
      const state: SshConnectState = { root: transport.root, caps: transport.caps };
      if (transport.scratch) state.scratch = transport.scratch;
      if (transport.probe?.os) state.os = transport.probe.os;
      return state;
    }, { long: true, audit: { label: "connected to a server" } });
    context.registerCommand("ssh-list", async (input) => {
      const transport = await this.transport(input);
      const path = (input as { path?: unknown } | undefined)?.path;
      try {
        return await transport.list(typeof path === "string" ? path : "") satisfies ServerEntry[];
      } catch (error) {
        throw commandError(error);
      }
    }, { long: true, audit: { label: "listed a server folder" } });
    this.unhook = context.services.registerThreadLifecycle({
      afterWorkspaceClose: (cwd) => this.connections.closeWorkspace(cwd),
    });
  }

  async dispose(): Promise<void> {
    this.unhook?.();
    await this.connections.closeAll();
    await this.askpass.close();
  }
}

/** What the server answered is not a broken command; the registry counts only those. */
const commandError = (error: unknown) =>
  error instanceof SshConnectError || error instanceof ServerPathError || error instanceof SftpError ? new HostCommandError(error.message) : error;
