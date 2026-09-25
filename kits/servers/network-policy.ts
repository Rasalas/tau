import { access } from "node:fs/promises";
import { join } from "node:path";
import {
  HostCommandError,
  normalizeAllowedHost,
  readPersistedJson,
  writePersistedJson,
  type HostExecutionPolicyRule,
  type HostExtensionContext,
  type HostExtensionServices,
  type PersistedJsonLogger,
} from "tau/host-extension";
import type { ServerNetworkState } from "./protocol.js";
import { SFTP_JSON_PATH } from "./sftp-json.js";
import { MainCheckouts, isStoreSegment, type GitRunner, type ServersStore } from "./store.js";

/**
 * Package sources a server project's agent reaches without asking (the user's
 * decision of 2026-09-25): npm and Yarn, Packagist, GitHub, PyPI, RubyGems,
 * crates.io, Go modules and JSR.
 */
export const PACKAGE_SOURCE_HOSTS: readonly string[] = [
  "registry.npmjs.org", "registry.yarnpkg.com", "repo.yarnpkg.com",
  "packagist.org", "repo.packagist.org", "getcomposer.org",
  "github.com", "api.github.com", "codeload.github.com", "*.githubusercontent.com",
  "pypi.org", "files.pythonhosted.org",
  "rubygems.org", "index.rubygems.org",
  "crates.io", "index.crates.io", "static.crates.io",
  "proxy.golang.org", "sum.golang.org",
  "jsr.io", "npm.jsr.io",
];

export const NETWORK_LIMIT_REASON = "This project deploys to a server, so the agent's commands reach only this machine and package sources (Settings → Servers).";

/** `network.json` beside a project's targets: what the user allowed beyond the package sources. */
export interface ProjectNetwork extends Record<string, unknown> {
  /** The whole network, as outside a server project. */
  allowAll: boolean;
  /** Hosts beyond the package sources. */
  allowHosts: string[];
}

const NETWORK_FILE = "network.json";
const NETWORK_VERSION = 1;

export function decodeProjectNetwork(value: unknown): ProjectNetwork | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { allowAll, allowHosts } = value as Record<string, unknown>;
  const hosts = Array.isArray(allowHosts) ? allowHosts.flatMap((host) => normalizeAllowedHost(host) ?? []) : [];
  return { allowAll: allowAll === true, allowHosts: [...new Set(hosts)].sort() };
}

export interface ServerNetworkOptions {
  services: Pick<HostExtensionServices, "workspaceRef">;
  store: ServersStore;
  logger: PersistedJsonLogger;
  git?: GitRunner;
  /** Shared with the kit's other readers, so Git is asked once per folder. */
  checkouts?: MainCheckouts;
  /** Tells the readers of the policy that a project's answer changed. */
  changed?(cwd: string): void;
  /** Whether Pi's commands can be held to the limit here, for Settings to say. */
  piEnforcement?(): Promise<{ available: boolean; reason?: string }>;
}

interface Project {
  root: string;
  workspaceId?: string;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

/**
 * The network limit of server projects: a project with an sftp.json or a
 * target folder reaches this machine and the package sources, plus what the
 * user allowed, or everything once the user lifted the limit. Kept per project
 * on this machine, never in the project.
 */
export class ServerNetwork {
  private readonly checkouts: MainCheckouts;

  constructor(private readonly options: ServerNetworkOptions) {
    this.checkouts = options.checkouts ?? new MainCheckouts(options.git);
  }

  private async project(cwd: string): Promise<Project> {
    const root = await this.checkouts.of(cwd);
    let workspaceId: string | undefined;
    try { workspaceId = this.options.services.workspaceRef(root).workspaceId; } catch { /* a folder the host has no id for keeps no settings */ }
    return { root, ...(workspaceId && isStoreSegment(workspaceId) ? { workspaceId } : {}) };
  }

  private networkPath(workspaceId: string): string {
    return join(this.options.store.targetsDir, workspaceId, NETWORK_FILE);
  }

  private async allowances(project: Project): Promise<ProjectNetwork> {
    if (!project.workspaceId) return { allowAll: false, allowHosts: [] };
    const read = await readPersistedJson(this.networkPath(project.workspaceId), { expectedVersion: NETWORK_VERSION, decode: decodeProjectNetwork, logger: this.options.logger });
    return read?.data ?? { allowAll: false, allowHosts: [] };
  }

  private async isServerProject(project: Project): Promise<boolean> {
    if (await exists(join(project.root, SFTP_JSON_PATH))) return true;
    return project.workspaceId ? (await this.options.store.targets(project.workspaceId)).length > 0 : false;
  }

  /** The kit's rule for `services.executionPolicy`; nothing for a project without servers. */
  async rule(cwd: string): Promise<HostExecutionPolicyRule | undefined> {
    const project = await this.project(cwd);
    if (!(await this.isServerProject(project))) return undefined;
    const settings = await this.allowances(project);
    if (settings.allowAll) return { network: "any" };
    return { network: "loopback", allowHosts: [...PACKAGE_SOURCE_HOSTS, ...settings.allowHosts], reason: NETWORK_LIMIT_REASON };
  }

  async state(cwd: unknown): Promise<ServerNetworkState> {
    if (typeof cwd !== "string" || !cwd) throw new HostCommandError("Open a project first.");
    const project = await this.project(cwd);
    const settings = await this.allowances(project);
    const pi = await this.options.piEnforcement?.();
    return {
      serverProject: await this.isServerProject(project),
      allowAll: settings.allowAll,
      allowHosts: settings.allowHosts,
      packageSources: [...PACKAGE_SOURCE_HOSTS],
      ...(pi ? { pi } : {}),
    };
  }

  /** Replaces what the user allowed; hosts that are not host names are refused, not dropped. */
  async set(input: unknown): Promise<ServerNetworkState> {
    const { cwd, allowAll, allowHosts } = (input ?? {}) as { cwd?: unknown; allowAll?: unknown; allowHosts?: unknown };
    if (typeof cwd !== "string" || !cwd) throw new HostCommandError("Open a project first.");
    if (allowAll !== undefined && typeof allowAll !== "boolean") throw new HostCommandError("allowAll is true or false.");
    if (allowHosts !== undefined && !Array.isArray(allowHosts)) throw new HostCommandError("allowHosts is a list of host names.");
    const hosts = (allowHosts ?? []).map((host) => {
      const normalized = normalizeAllowedHost(host);
      if (!normalized) throw new HostCommandError(`"${String(host)}" is not a host name; write example.com or *.example.com.`);
      return normalized;
    });
    const project = await this.project(cwd);
    if (!project.workspaceId) throw new HostCommandError("This project has no id the servers store can keep.");
    const current = await this.allowances(project);
    const next: ProjectNetwork = {
      allowAll: typeof allowAll === "boolean" ? allowAll : current.allowAll,
      allowHosts: allowHosts === undefined ? current.allowHosts : [...new Set(hosts)].sort(),
    };
    await writePersistedJson(this.networkPath(project.workspaceId), NETWORK_VERSION, next, { logger: this.options.logger });
    this.options.changed?.(cwd);
    return this.state(cwd);
  }

  register(context: HostExtensionContext): void {
    context.registerCommand("network", (input) => this.state((input as { cwd?: unknown } | undefined)?.cwd), { access: "read" });
    context.registerCommand("set-network", (input) => this.set(input), { audit: { label: "changed a project's network limit" } });
  }
}
