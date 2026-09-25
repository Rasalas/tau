import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { HostCommandError, type HostExtensionContext, type HostExtensionServices } from "tau/host-extension";
import {
  SERVERS_SSH_CONFIG_ENV, type ServerTargetIssue, type ServerTargetRow, type ServerTargetsState, type SshHostsState,
} from "./protocol.js";
import {
  SFTP_JSON_PATH, readProfileChoices, readSftpJsonFile, writeProfileChoice, writeSftpJson,
  type CredentialSpec, type SftpJsonDraft, type SftpJsonIssue, type SftpJsonTarget,
} from "./sftp-json.js";
import { listSshHosts, resolveSshHost, type ResolvedSshHost } from "./ssh-hosts.js";
import { MainCheckouts, isStoreSegment, type GitRunner, type ServersStore } from "./store.js";

const MANAGER_LABELS: Record<string, string> = {
  keychain: "Keychain",
  vscode: "VS Code's secret storage",
  "secret-tool": "Secret Service (secret-tool)",
  "1password": "1Password",
  pass: "pass",
  gopass: "gopass",
  bitwarden: "Bitwarden",
};

/** Where a secret comes from, in words; never the value, never the command's text. */
export function describeCredential(spec: CredentialSpec | undefined): string {
  if (!spec) return "None";
  if (spec.command) return "Command in sftp.json";
  const manager = spec.manager;
  if (manager?.kind === "none") return spec.value === "plain" ? "Plain text in sftp.json" : "Asked every time";
  if (manager && manager.kind !== "default") {
    const label = manager.kind === "unknown" ? `Unknown manager "${manager.value}"` : MANAGER_LABELS[manager.kind] ?? manager.kind;
    return "ref" in manager && manager.ref ? `${label} (${manager.ref})` : label;
  }
  return spec.value === "plain" ? "Plain text in sftp.json" : "Asked once, then kept in the keychain";
}

const hasSftpJson = (root: string) => access(join(root, SFTP_JSON_PATH)).then(() => true, () => false);

const issueRow = (issue: SftpJsonIssue): ServerTargetIssue => ({ code: issue.code, level: issue.level, message: issue.message });

export function targetRow(target: SftpJsonTarget): ServerTargetRow {
  const label = target.name ?? (target.context || target.host || "sftp.json");
  return {
    id: target.id,
    configKey: target.configKey,
    source: "sftp.json",
    label,
    context: target.context,
    profiles: target.profiles,
    ...(target.profile ? { profile: target.profile } : {}),
    protocol: target.protocol,
    host: target.host,
    port: target.port,
    ...(target.username ? { username: target.username } : {}),
    remotePath: target.remotePath,
    password: describeCredential(target.password),
    ...(target.privateKeyPath ? { privateKeyPath: target.privateKeyPath } : {}),
    ...(target.passphrase ? { passphrase: describeCredential(target.passphrase) } : {}),
    issues: target.issues.map(issueRow),
    usable: target.usable,
  };
}

export interface ServerTargetsOptions {
  services: HostExtensionServices;
  store: ServersStore;
  git?: GitRunner;
  /** Shared with the kit's other readers, so Git is asked once per folder. */
  checkouts?: MainCheckouts;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/**
 * The targets of a project and the SSH hosts of this machine, for Settings and
 * the tickets after this one. Everything is keyed by the main checkout.
 */
export class ServerTargets {
  private readonly checkouts: MainCheckouts;

  constructor(private readonly options: ServerTargetsOptions) {
    this.checkouts = options.checkouts ?? new MainCheckouts(options.git);
  }

  /** The main checkout behind `cwd` and the key of its state. */
  async project(cwd: unknown): Promise<{ root: string; workspaceId: string; choicesPath: string }> {
    if (typeof cwd !== "string" || !cwd) throw new HostCommandError("Open a project first.");
    const known = await this.options.services.knownWorkspacePath(cwd);
    const root = await this.checkouts.of(known);
    const { workspaceId } = this.options.services.workspaceRef(root);
    if (!isStoreSegment(workspaceId)) throw new HostCommandError("This project has no id the servers store can keep.");
    return { root, workspaceId, choicesPath: join(this.options.store.targetsDir, workspaceId, "profiles.json") };
  }

  async state(cwd: unknown): Promise<ServerTargetsState> {
    const { root, choicesPath } = await this.project(cwd);
    if (!await hasSftpJson(root)) return { workspace: root, targets: [], issues: [] };
    const profileChoices = await readProfileChoices(choicesPath);
    const read = await readSftpJsonFile(root, { profileChoices });
    if (!read) return { workspace: root, targets: [], issues: [] };
    return { workspace: root, file: join(root, SFTP_JSON_PATH), targets: read.targets.map(targetRow), issues: read.issues.map(issueRow) };
  }

  /** The project's targets as they read now, profiles applied; for connecting and for their secrets. */
  async list(cwd: unknown): Promise<{ project: { root: string; workspaceId: string }; targets: SftpJsonTarget[] }> {
    const { root, workspaceId, choicesPath } = await this.project(cwd);
    // Most projects have no servers; they are answered without reading the profile choices.
    if (!await hasSftpJson(root)) return { project: { root, workspaceId }, targets: [] };
    const read = await readSftpJsonFile(root, { profileChoices: await readProfileChoices(choicesPath) });
    return { project: { root, workspaceId }, targets: read?.targets ?? [] };
  }

  async target(cwd: unknown, targetId: unknown): Promise<{ project: { root: string; workspaceId: string }; target: SftpJsonTarget }> {
    if (typeof targetId !== "string" || !targetId) throw new HostCommandError("Name the server.");
    const { project, targets } = await this.list(cwd);
    const target = targets.find((candidate) => candidate.id === targetId);
    if (!target) throw new HostCommandError("sftp.json no longer names this server.");
    return { project, target };
  }

  async setProfile(input: unknown): Promise<ServerTargetsState> {
    const { cwd, configKey, profile } = (input ?? {}) as { cwd?: unknown; configKey?: unknown; profile?: unknown };
    if (typeof configKey !== "string" || !configKey) throw new HostCommandError("Name the configuration.");
    if (profile !== undefined && profile !== null && typeof profile !== "string") throw new HostCommandError("A profile is a name.");
    const { root, choicesPath } = await this.project(cwd);
    const read = await readSftpJsonFile(root);
    const target = read?.targets.find((candidate) => candidate.configKey === configKey);
    if (!target) throw new HostCommandError(`sftp.json has no configuration "${configKey}".`);
    if (typeof profile === "string" && !target.profiles.includes(profile)) throw new HostCommandError(`"${configKey}" has no profile "${profile}".`);
    await writeProfileChoice(choicesPath, configKey, typeof profile === "string" ? profile : undefined);
    return this.state(cwd);
  }

  /** Only on the user's explicit request (a button that says so); never over an existing file. */
  async writeSftpJson(input: unknown): Promise<ServerTargetsState> {
    const { cwd, drafts } = (input ?? {}) as { cwd?: unknown; drafts?: unknown };
    if (!Array.isArray(drafts)) throw new HostCommandError("Nothing to write.");
    const { root } = await this.project(cwd);
    const clean: SftpJsonDraft[] = drafts.map((draft) => {
      const value = (draft ?? {}) as Record<string, unknown>;
      if (typeof value.host !== "string" || typeof value.remotePath !== "string") throw new HostCommandError("Each configuration needs a host and a folder on the server.");
      return {
        protocol: value.protocol === "ftp" ? "ftp" : "sftp",
        host: value.host,
        remotePath: value.remotePath,
        ...(typeof value.name === "string" ? { name: value.name } : {}),
        ...(typeof value.context === "string" ? { context: value.context } : {}),
        ...(typeof value.port === "number" ? { port: value.port } : {}),
        ...(typeof value.username === "string" ? { username: value.username } : {}),
        ...(typeof value.privateKeyPath === "string" ? { privateKeyPath: value.privateKeyPath } : {}),
      };
    });
    try {
      await writeSftpJson(root, clean);
    } catch (error) {
      throw new HostCommandError((error as NodeJS.ErrnoException).code === "EEXIST" ? "This project already has an sftp.json; Tau does not replace it." : String((error as Error).message));
    }
    return this.state(cwd);
  }

  /**
   * The ssh config Tau reads: the one a test instance names, else the user's.
   * With the loopback guard on and none named, the user's own is off limits.
   */
  private sshConfig(): { path: string; explicit: boolean } {
    const env = this.options.env ?? process.env;
    const named = env[SERVERS_SSH_CONFIG_ENV];
    if (named) return { path: named, explicit: true };
    if (env.TAU_SERVERS_LOOPBACK_ONLY === "1") throw new HostCommandError(`${SERVERS_SSH_CONFIG_ENV} is not set; a test instance never reads the real ssh config.`);
    return { path: join(this.options.home ?? homedir(), ".ssh", "config"), explicit: false };
  }

  async sshHosts(): Promise<SshHostsState> {
    const config = this.sshConfig();
    const { hosts, problems } = await listSshHosts(config.path, { home: this.options.home ?? homedir() });
    return { configPath: config.path, hosts: hosts.map((host) => host.alias), problems };
  }

  async resolveSshHost(input: unknown): Promise<ResolvedSshHost> {
    const alias = (input as { alias?: unknown } | undefined)?.alias;
    if (typeof alias !== "string") throw new HostCommandError("Name an ssh host.");
    const ssh = this.options.services.findCommand("ssh");
    if (!ssh) throw new HostCommandError("ssh is not on this machine's PATH.");
    const config = this.sshConfig();
    try {
      return await resolveSshHost(alias, { ssh, ...(config.explicit ? { configPath: config.path } : {}) });
    } catch (error) {
      throw new HostCommandError((error as Error).message);
    }
  }

  register(context: HostExtensionContext): void {
    context.registerCommand("targets", (input) => this.state((input as { cwd?: unknown } | undefined)?.cwd), { access: "read" });
    context.registerCommand("set-profile", (input) => this.setProfile(input), { audit: { label: "chose a server profile" } });
    context.registerCommand("write-sftp-json", (input) => this.writeSftpJson(input), { audit: { label: "wrote an sftp.json" } });
    context.registerCommand("ssh-hosts", () => this.sshHosts(), { access: "read" });
    context.registerCommand("resolve-ssh-host", (input) => this.resolveSshHost(input), { access: "read" });
  }
}
