import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, posix, resolve, sep } from "node:path";
import { HostCommandError, type HostExtensionContext, type HostExtensionServices } from "tau/host-extension";
import {
  NEW_PROJECT_IGNORE, excludeLinesFor, excludedFolderLines, newProjectGitignore, normalizeExcluded, serverStateMessage,
  type DraftListing, type DraftServer, type FolderInspection, type ProjectMade,
} from "./project-plan.js";
import { SFTP_JSON_PATH, readProfileChoices, readSftpJsonFile, renderSftpJson, writeSftpJson, type SftpJsonDraft, type SftpJsonTarget } from "./sftp-json.js";
import { parseManualTarget } from "./ssh-hosts.js";
import type { ServerSsh } from "./ssh-service.js";
import type { SshTarget } from "./ssh-target.js";
import { SERVERS_PROJECTS_ROOT_ENV, type ProjectsRootState } from "./protocol.js";
import type { ServersStore } from "./store.js";
import { SyncIgnore } from "./sync/ignore.js";
import { MIRROR_REF } from "./sync/mirror.js";
import type { ScanSummary } from "./sync/protocol.js";
import { scanServer, summarize } from "./sync/scan.js";
import { answerError, type SyncService } from "./sync/service.js";
import { targetRow, type ServerTargets } from "./targets.js";

/** Workspace Kit writes the project's Git; this kit never does (ADR 0020, plan-I §1.4). */
const WORKSPACE_KIT_ID = "tau.workspace";

export interface ServerProjectsOptions {
  services: HostExtensionServices;
  store: ServersStore;
  targets: ServerTargets;
  ssh: ServerSsh;
  sync: SyncService;
  /** A Workspace Kit command, called as this kit. */
  workspace(command: string, input: unknown): Promise<unknown>;
  /** The folder every local project folder must lie in; `TAU_SERVERS_PROJECTS_ROOT` by default. */
  projectsRoot?: string;
}

/** The guard's folder from the environment, absolute; undefined when unset. */
export function projectsRootFrom(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[SERVERS_PROJECTS_ROOT_ENV]?.trim();
  return value ? resolve(expandHome(value)) : undefined;
}

interface RepoFromTreeAnswer { commit: string; branch: string; files: number }

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});
const shortHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 10);

function expandHome(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "~") return homedir();
  return trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
}

function decodeServer(value: unknown): DraftServer {
  const input = record(value);
  if (typeof input.alias === "string" && input.alias.trim()) return { alias: input.alias.trim() };
  if (typeof input.address === "string" && input.address.trim()) return { address: input.address.trim() };
  throw new HostCommandError("Choose an ssh host or enter an address.");
}

function remoteFolder(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) throw new HostCommandError("Choose an absolute folder on the server.");
  return posix.normalize(value);
}

/**
 * An existing local folder, resolved. With a projects root (a test instance),
 * it must be that folder or lie inside it, links resolved, like the loopback guard.
 */
async function localFolder(value: unknown, root: string | undefined): Promise<string> {
  if (typeof value !== "string" || !value.trim()) throw new HostCommandError("Name the local folder.");
  const path = expandHome(value);
  if (!isAbsolute(path)) throw new HostCommandError("The local folder must be an absolute path.");
  // The root is the default parent of a new project, so it exists before anyone asks.
  if (root) await mkdir(root, { recursive: true });
  let real: string;
  try {
    real = await realpath(path);
    if (!(await stat(real)).isDirectory()) throw new Error("not a folder");
  } catch {
    throw new HostCommandError(`${path} is not a folder on this machine.`);
  }
  if (root) {
    const inside = await realpath(root);
    if (real !== inside && !real.startsWith(`${inside}${sep}`)) {
      throw new HostCommandError(`${path} is outside ${inside}, the only folder this Tau makes or links server projects in (${SERVERS_PROJECTS_ROOT_ENV}).`);
    }
  }
  return real;
}

function parseAddress(address: string): { host: string; port: number; username?: string } {
  const parsed = parseManualTarget(address, "/");
  if (!parsed.target) throw new HostCommandError(parsed.error ?? "Enter a host name or address.");
  if (parsed.target.protocol !== "sftp") throw new HostCommandError("A new project from an address goes over SSH; for an FTP server, open a folder with its sftp.json instead.");
  return { host: parsed.target.host, port: parsed.target.port, ...(parsed.target.username ? { username: parsed.target.username } : {}) };
}

const hasGit = async (path: string) => Boolean(await lstat(join(path, ".git")).catch(() => undefined));

/**
 * A project from a server (plan-I §1.3): browse the server, size its folders,
 * download into a new folder and let Workspace Kit make the first commit from
 * the mirror state. And the other way in: a folder with an sftp.json and no
 * Git gets a repository whose first commit is the server, its files untouched.
 */
export class ServerProjects {
  constructor(private readonly options: ServerProjectsOptions) {}

  /** The address a new project's connection starts from; no local paths, as a client may name it. */
  private draftTarget(server: DraftServer, remotePath: string, id: string): SshTarget {
    if ("alias" in server) return { id, host: server.alias, alias: server.alias, remotePath };
    const { host, port, username } = parseAddress(server.address);
    return { id, host, port, remotePath, ...(username ? { username } : {}) };
  }

  /** The sftp.json entry of a new project, without a password; an alias stays the host, so the ssh config keeps its say. */
  private async sftpEntry(server: DraftServer, remotePath: string): Promise<{ draft: SftpJsonDraft; label: string }> {
    if ("alias" in server) {
      const resolved = await this.options.targets.resolveSshHost({ alias: server.alias });
      return {
        label: server.alias,
        draft: { name: server.alias, protocol: "sftp", host: server.alias, port: resolved.port, ...(resolved.user ? { username: resolved.user } : {}), remotePath, ignore: [...NEW_PROJECT_IGNORE] },
      };
    }
    const { host, port, username } = parseAddress(server.address);
    return { label: host, draft: { name: host, protocol: "sftp", host, port, ...(username ? { username } : {}), remotePath, ignore: [...NEW_PROJECT_IGNORE] } };
  }

  /** One folder of the server; without `path`, the folder a login lands in. */
  async browse(input: unknown): Promise<DraftListing> {
    const server = decodeServer(record(input).server);
    const requested = record(input).path;
    const key = shortHash(JSON.stringify(server));
    let path: string;
    if (typeof requested === "string" && requested) {
      path = remoteFolder(requested);
    } else {
      path = (await this.options.ssh.draftTransport(this.draftTarget(server, ".", `draft-start-${key}`))).root;
    }
    // Rooted at `/` so the user can go anywhere; this connection only lists folders.
    const fs = await this.options.ssh.draftTransport(this.draftTarget(server, "/", `draft-browse-${key}`));
    path = await fs.realpath(path);
    const entries = await fs.list(path);
    const directories = entries
      .filter((entry) => entry.type === "directory" && entry.name !== ".git")
      .map((entry) => ({ name: entry.name, path: entry.path }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return {
      path,
      ...(path !== "/" ? { parent: posix.dirname(path) } : {}),
      directories,
      files: entries.filter((entry) => entry.type === "file").length,
    };
  }

  /** The size overview of a server folder before anything comes down. */
  async draftScan(input: unknown): Promise<ScanSummary> {
    const server = decodeServer(record(input).server);
    const remotePath = remoteFolder(record(input).remotePath);
    const id = `draft-scan-${shortHash(`${JSON.stringify(server)}\0${remotePath}`)}`;
    const fs = await this.options.ssh.draftTransport(this.draftTarget(server, remotePath, id));
    // No local folder yet, so no Git rules: only what the new sftp.json will leave out.
    const ignore = await SyncIgnore.create({ localDir: this.options.services.stateDir, patterns: NEW_PROJECT_IGNORE, gitRules: false });
    return summarize(id, await scanServer(fs, ignore), false);
  }

  /** Where new projects go and linked folders must be, while the guard is on. */
  private get root(): string | undefined {
    return "projectsRoot" in this.options ? this.options.projectsRoot : projectsRootFrom();
  }

  projectsRoot(): ProjectsRootState {
    return { root: this.root ?? null };
  }

  async create(input: unknown): Promise<ProjectMade> {
    const fields = record(input);
    const server = decodeServer(fields.server);
    const remotePath = remoteFolder(fields.remotePath);
    const parent = await localFolder(fields.parent, this.root);
    const name = typeof fields.name === "string" ? fields.name.trim() : "";
    if (!name || name === "." || name === ".." || /[\\/\0]/u.test(name)) throw new HostCommandError("Name the new folder.");
    const exclude = normalizeExcluded(Array.isArray(fields.exclude) ? fields.exclude.filter((path): path is string => typeof path === "string") : []);
    const folder = join(parent, name);
    const existing = await readdir(folder).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? undefined : Promise.reject(error)));
    if (existing && existing.length > 0) throw new HostCommandError(`${folder} is not empty; choose a new folder.`);
    const { draft, label } = await this.sftpEntry(server, remotePath);
    await mkdir(folder, { recursive: true });
    const path = await realpath(folder);
    try {
      await writeSftpJson(path, [draft]);
      this.options.services.admitWorkspace(path);
      const { project, targets } = await this.options.targets.list(path);
      const target = targets[0];
      if (!target?.usable) throw new HostCommandError("The new sftp.json names no server Tau can reach.");
      const downloaded = await this.options.sync.download({ cwd: path, targetId: target.id, exclude }, { gitRules: false });
      if (downloaded.failed.length) throw new HostCommandError(`${downloaded.failed.length} files could not be downloaded, first ${downloaded.failed[0]!.path}: ${downloaded.failed[0]!.message}`);
      // A server without its own .gitignore gets Tau's; one with it keeps it as it is, and Git's own exclude file takes the rest.
      const serverGitignore = Boolean(await lstat(join(path, ".gitignore")).catch(() => undefined));
      if (!serverGitignore) {
        await writeFile(join(path, ".gitignore"), newProjectGitignore(exclude, SFTP_JSON_PATH.split("\\").join("/")));
        // Tau's .gitignore stays local like the sftp.json: never an upload, never pending.
        await writeFile(join(path, SFTP_JSON_PATH), renderSftpJson([{ ...draft, ignore: [...NEW_PROJECT_IGNORE, "/.gitignore"] }]));
      }
      const made = await this.options.workspace("repo-from-tree", {
        path,
        trees: [{ gitDir: this.options.store.mirrorDir({ workspaceId: project.workspaceId, targetId: target.id }), ref: MIRROR_REF }],
        files: serverGitignore ? [] : [".gitignore"],
        exclude: serverGitignore ? [...excludedFolderLines(exclude), "/.vscode/sftp.json"] : [],
        message: serverStateMessage(label, remotePath, new Date()),
      }) as RepoFromTreeAnswer;
      this.options.services.log("servers.project.created", `${path} ${made.commit.slice(0, 7)}`);
      return {
        workspaceId: this.options.services.workspaceRef(path).workspaceId, path,
        commit: made.commit, branch: made.branch, files: made.files,
        ignoredIn: serverGitignore ? "exclude" : "gitignore",
        liveConfigs: downloaded.liveConfigs,
      };
    } catch (error) {
      // The folder was new or empty: nothing of the user's is lost, and a retry starts clean.
      await rm(path, { recursive: true, force: true });
      throw error;
    }
  }

  async inspect(input: unknown): Promise<FolderInspection> {
    const path = await localFolder(record(input).path, this.root);
    const { workspaceId } = this.options.services.workspaceRef(path);
    const profileChoices = await readProfileChoices(join(this.options.store.targetsDir, workspaceId, "profiles.json"));
    const read = await readSftpJsonFile(path, { profileChoices });
    if (!read) throw new HostCommandError(`${path} has no ${SFTP_JSON_PATH.split("\\").join("/")}.`);
    const names = await readdir(path);
    return {
      path,
      hasGit: await hasGit(path),
      empty: names.every((entry) => entry === ".vscode" || entry === ".DS_Store"),
      targets: read.targets.map(targetRow),
      issues: read.issues.map((issue) => ({ code: issue.code, level: issue.level, message: issue.message })),
    };
  }

  /** The size overview of one sftp.json target of a folder that has no Git yet. */
  async linkScan(input: unknown): Promise<ScanSummary> {
    const path = await localFolder(record(input).path, this.root);
    if (await hasGit(path)) throw new HostCommandError(`${path} has Git already.`);
    this.options.services.admitWorkspace(path);
    return this.options.sync.scan({ cwd: path, targetId: record(input).targetId }, { gitRules: false });
  }

  private async linkTargets(path: string): Promise<{ workspaceId: string; targets: SftpJsonTarget[] }> {
    const { project, targets } = await this.options.targets.list(path);
    if (targets.length === 0) throw new HostCommandError("The sftp.json names no server.");
    const unusable = targets.find((target) => !target.usable);
    if (unusable) throw new HostCommandError(`${unusable.name ?? unusable.host} cannot be reached as sftp.json names it.`);
    return { workspaceId: project.workspaceId, targets };
  }

  /**
   * Git for a folder that holds a site already: every target's server state
   * becomes the first commit (below its `context`), the files stay as they
   * are, so `git status` shows exactly where the folder differs from the server.
   */
  async link(input: unknown): Promise<ProjectMade> {
    const fields = record(input);
    const path = await localFolder(fields.path, this.root);
    if (await hasGit(path)) throw new HostCommandError(`${path} has Git already.`);
    const download = fields.download === true;
    const excluded = record(fields.exclude);
    this.options.services.admitWorkspace(path);
    const { workspaceId, targets } = await this.linkTargets(path);
    const lines = ["/.vscode/sftp.json"];
    let liveConfigs = 0;
    for (const target of targets) {
      const exclude = normalizeExcluded(Array.isArray(excluded[target.id]) ? (excluded[target.id] as unknown[]).filter((entry): entry is string => typeof entry === "string") : []);
      const result = await this.options.sync.download({ cwd: path, targetId: target.id, exclude }, download ? { gitRules: false } : { gitRules: false, mirrorOnly: true });
      liveConfigs += result.liveConfigs;
      lines.push(...excludedFolderLines(exclude, target.context), ...excludeLinesFor(target.ignore, target.context));
    }
    const made = await this.options.workspace("repo-from-tree", {
      path,
      trees: targets.map((target) => ({ gitDir: this.options.store.mirrorDir({ workspaceId, targetId: target.id }), ref: MIRROR_REF, prefix: target.context })),
      exclude: [...new Set(lines)],
      message: serverStateMessage(targets.map((target) => target.host).join(", "), targets.map((target) => target.remotePath).join(", "), new Date()),
    }) as RepoFromTreeAnswer;
    this.options.services.log("servers.project.linked", `${path} ${made.commit.slice(0, 7)}`);
    return {
      workspaceId: this.options.services.workspaceRef(path).workspaceId, path,
      commit: made.commit, branch: made.branch, files: made.files, ignoredIn: "exclude", liveConfigs,
    };
  }

  register(context: HostExtensionContext): () => void {
    const { ssh } = this.options;
    const wrap = <T>(run: (input: unknown) => Promise<T>) => async (input: unknown) => {
      try {
        return await run(input);
      } catch (error) {
        // A folder this machine refuses is an answer too.
        if (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string" && !(error instanceof HostCommandError)) throw new HostCommandError(error.message);
        throw answerError(error);
      }
    };
    // `long`: a login may wait on a dialog; a scan or a download can take minutes.
    context.registerCommand("draft-browse", wrap((input) => this.browse(input)), { long: true });
    context.registerCommand("draft-scan", wrap((input) => this.draftScan(input)), { long: true, audit: { label: "sized a server folder" } });
    context.registerCommand("draft-close", () => ssh.closeDrafts());
    context.registerCommand("create-project", wrap((input) => this.create(input)), { long: true, audit: { label: "made a project from a server" } });
    context.registerCommand("inspect-folder", wrap((input) => this.inspect(input)), { access: "read" });
    context.registerCommand("projects-root", () => this.projectsRoot(), { access: "read" });
    context.registerCommand("link-scan", wrap((input) => this.linkScan(input)), { long: true, audit: { label: "sized a server folder" } });
    context.registerCommand("link-folder", wrap((input) => this.link(input)), { long: true, audit: { label: "made Git for a server folder" } });
    return () => void ssh.closeDrafts();
  }
}

/** Registers the project commands; Workspace Kit's Git commands are called as this kit. */
export function registerServerProjects(context: HostExtensionContext, options: Omit<ServerProjectsOptions, "services" | "workspace">): () => void {
  return new ServerProjects({
    ...options,
    services: context.services,
    workspace: (command, input) => context.invokeHostExtension(WORKSPACE_KIT_ID, command, input),
  }).register(context);
}
