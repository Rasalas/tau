import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import { AskpassBridge, AskpassDialogs, type CredentialSource } from "./askpass.js";
import { ASKPASS_ANSWER_COMMAND, ASKPASS_PENDING_COMMAND } from "./askpass-protocol.js";
import { ServerPathError, type ServerEntry } from "./server-fs.js";
import { SftpError } from "./sftp-client.js";
import type { SshTarget } from "./ssh-target.js";
import { isStoreSegment } from "./store.js";
import { SshConnectError, SshConnections, SshTransport } from "./transport-ssh.js";

export interface ServerSshOptions {
  /**
   * Asked before the dialog, in order: the credentials ticket's keychain and
   * command sources go here. The dialog answers what they pass on.
   */
  credentialSources?: readonly CredentialSource[];
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

/** SSH connections of the open projects, the askpass bridge and the dialog behind it. */
export class ServerSsh {
  readonly dialogs: AskpassDialogs;
  readonly askpass: AskpassBridge;
  readonly connections: SshConnections;
  private unhook: (() => void) | undefined;

  constructor(private readonly context: HostExtensionContext, options: ServerSshOptions = {}) {
    const services = context.services;
    this.dialogs = new AskpassDialogs((name, payload) => context.emit(name, payload));
    this.askpass = new AskpassBridge({ stateDir: services.stateDir, sources: [...(options.credentialSources ?? []), this.dialogs], ...(options.controlRoot ? { controlRoot: options.controlRoot } : {}) });
    this.connections = new SshConnections((target, workspace) => {
      const ssh = services.findCommand("ssh");
      if (!ssh) throw new HostCommandError("ssh is not on this machine's PATH.");
      return new SshTransport(target, {
        ssh, askpass: this.askpass, baseDir: workspace, onSpawn: () => services.noteSubprocess(),
        ...(options.controlRoot ? { controlRoot: options.controlRoot } : {}),
      });
    });
  }

  /** The transport of a project's target; connected on first use. */
  async transport(cwd: unknown, target: SshTarget): Promise<SshTransport> {
    if (typeof cwd !== "string" || !cwd) throw new HostCommandError("Open a project first.");
    const workspace = await this.context.services.knownWorkspacePath(cwd);
    const transport = this.connections.get(workspace, target);
    try {
      await transport.connect();
    } catch (error) {
      // A failed login or a refused target is an answer about the server, not a broken command.
      throw error instanceof Error ? new HostCommandError(error.message) : error;
    }
    return transport;
  }

  register(): void {
    const { context } = this;
    context.registerCommand(ASKPASS_ANSWER_COMMAND, (input) => this.dialogs.respond(input), { audit: { label: "answered a server login question" } });
    context.registerCommand(ASKPASS_PENDING_COMMAND, () => this.dialogs.pending(), { access: "read" });
    // `long`: a login may wait on the user's answer in a dialog.
    context.registerCommand("ssh-connect", async (input) => {
      const { cwd, target } = (input ?? {}) as { cwd?: unknown; target?: unknown };
      const transport = await this.transport(cwd, decodeClientTarget(target));
      const state: SshConnectState = { root: transport.root, caps: transport.caps };
      if (transport.scratch) state.scratch = transport.scratch;
      if (transport.probe?.os) state.os = transport.probe.os;
      return state;
    }, { long: true, audit: { label: "connected to a server" } });
    context.registerCommand("ssh-list", async (input) => {
      const { cwd, target, path } = (input ?? {}) as { cwd?: unknown; target?: unknown; path?: unknown };
      const transport = await this.transport(cwd, decodeClientTarget(target));
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
    this.dialogs.cancelAll();
    await this.connections.closeAll();
    await this.askpass.close();
  }
}

/** What the server or the user answered is not a broken command; the registry counts only those. */
const commandError = (error: unknown) =>
  error instanceof SshConnectError || error instanceof ServerPathError || error instanceof SftpError ? new HostCommandError(error.message) : error;
