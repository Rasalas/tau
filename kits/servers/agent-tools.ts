import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { HostExtensionContext, HostMcpTool, RuntimeSessionInfo } from "tau/host-extension";
import { decideServerCall, serverBypassIn, stricterLevel, type ServerCallRequest, type ServerVerdict } from "./agent-gate.js";
import { SERVER_TOOLS, serverMarkLine, serverToolName, type UploadProposal } from "./agent-protocol.js";
import type { DeployPreview, DeployRequestFile } from "./deploy-protocol.js";
import { diffBlobs } from "./history.js";
import type { TargetLevel } from "./protocol.js";
import type { ServerFs } from "./server-fs.js";
import { SFTP_JSON_PATH, type SftpJsonTarget } from "./sftp-json.js";
import { formatAddress } from "./status-model.js";
import type { TargetKey } from "./store.js";
import type { GitCall } from "./sync/git.js";
import { readLocalFile } from "./sync/local.js";
import { Mirror } from "./sync/mirror.js";
import { isSyncPath } from "./sync/paths.js";
import type { PendingUploadRow, ServersStatus } from "./view-protocol.js";

/*
 * The agent's server tools (plan-I §1.6), for Pi as a runtime extension and
 * for every other runtime over Tau's MCP endpoint. Reading is free; commands
 * and ~/tmp writes pass the gate; an upload is only ever proposed as a card
 * the user clicks. No tool here calls `deploy`.
 */

export const SERVER_INSTRUCTIONS = `<server_targets>
This project is a site that lives on a server (.vscode/sftp.json names it). The local folder is the working copy: edit, run and test locally with your normal tools.
- Look at the server with server_status, server_list, server_read and server_diff; reading is always allowed.
- Run commands on the server only with server_exec (cwd "project" is the site's folder on the server, "tmp" is ~/tmp for scratch work); put scratch files there with server_put_tmp. Do not reach the server with ssh, scp, sftp, rsync, lftp or curl from the local shell. Depending on the user's settings a server command first asks the user, runs, or is refused.
- An FTP server runs no commands: server_exec is refused there; server_put_tmp and the reading tools still work.
- Git on the server is read-only: status, log and diff work; commit, push, pull, checkout, reset, merge, stash, add, rm and clean are refused at every level. Commit in the local project instead.
- Only the user uploads. When local changes are ready, call server_propose_upload: the user sees a card with the files and an Upload button. Nothing goes up until they click it, so never say the files are on the server.
</server_targets>`;

const READ_CAP = 128 * 1024;
const LIST_CAP = 500;
const DIFF_PATHS_CAP = 20;
const OUTPUT_CAP = 32 * 1024;
const PUT_CAP = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 600;

export interface ServerAgentToolsOptions {
  /** A project's targets as they read now, keyed by its main checkout. */
  list(cwd: string): Promise<{ project: { root: string; workspaceId: string }; targets: SftpJsonTarget[] }>;
  transport(input: { cwd: string; targetId: string }): Promise<ServerFs>;
  status(input: { cwd: string }): Promise<ServersStatus>;
  /** `deploy-preview`: reads the server, writes nothing. */
  preview(input: { cwd: string; targetId: string; files: DeployRequestFile[] }): Promise<DeployPreview>;
  targetLevel(key: TargetKey): Promise<TargetLevel>;
  /** Access Kit's level for the thread; undefined when there is none. */
  threadLevel(threadId: string): Promise<TargetLevel | undefined>;
  mirrorDir(key: TargetKey): string;
  git: GitCall;
  log?(label: string, detail: string): void;
}

interface Resolved {
  target: SftpJsonTarget;
  key: TargetKey;
  label: string;
  address: string;
  /** The target's folder in the thread's checkout. */
  localDir: string;
}

const labelOf = (target: SftpJsonTarget) => target.name ?? (target.context || target.host || "sftp.json");
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" ? value as Record<string, unknown> : {});
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const result = (body: string) => ({ content: [{ type: "text" as const, text: body }], details: undefined });

function cap(data: string, limit: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(data) <= limit) return { text: data, truncated: false };
  return { text: Buffer.from(data).subarray(0, limit).toString("utf8"), truncated: true };
}

const isBinary = (data: Buffer) => data.subarray(0, 8000).includes(0);

const TARGET_PARAM = Type.Optional(Type.String({ description: "The server target's id or name, as server_status lists it; may be left out when the project has one server." }));

/** A relative path of the site, or `~/tmp/…`. */
function serverPath(value: unknown, allowTmp: boolean): string {
  const raw = text(value)?.replace(/^\.\/+/u, "") ?? "";
  if (raw === "" || raw === ".") return "";
  if (allowTmp && (raw === "~/tmp" || raw.startsWith("~/tmp/"))) return raw;
  if (!isSyncPath(raw)) throw new Error(`${raw}: name a path relative to the site's folder${allowTmp ? " or one below ~/tmp" : ""}.`);
  return raw;
}

function projectPath(value: unknown): string {
  const raw = text(value)?.replace(/^\.\/+/u, "");
  if (!raw || !isSyncPath(raw)) throw new Error(`${String(value)}: name a path relative to the site's folder.`);
  return raw;
}

/** The line server_exec sends; the lock setting keeps `git status` from writing index.lock. */
export function serverExecCommand(command: string): string {
  return `export GIT_OPTIONAL_LOCKS=0\n${command}`;
}

const noCommands = (label: string) => `${label} is an FTP server: it runs no commands, so server_exec cannot work there. Read it with server_read, server_list and server_diff, and test locally.`;

/** Renders a parsed diff back as a unified patch the model reads. */
function patchText(diff: Awaited<ReturnType<typeof diffBlobs>>): string {
  if (diff.note) return diff.note;
  if (!diff.hunks.length) return "No difference.";
  const lines: string[] = [];
  for (const hunk of diff.hunks) {
    lines.push(hunk.header);
    for (const line of hunk.lines) lines.push(`${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}${line.text}`);
  }
  if (diff.truncated) lines.push("… (diff cut short)");
  return lines.join("\n");
}

/** A call the target cannot take at all is refused before any question. */
function verdictOf(request: ServerCallRequest & { refused?: string }): ServerVerdict {
  return request.refused ? { kind: "block", reason: `Blocked by Tau: ${request.refused}` } : decideServerCall(request);
}

/**
 * The seven tools and their gate. One instance per kit; `tools(session)`
 * builds the tools a thread sees, `gate` decides a call for either door.
 */
export class ServerAgentTools {
  /** Whether a checkout is a server project and has a target that may run commands (not FTP), as last read; the MCP door asks synchronously. */
  private readonly known = new Map<string, { server: boolean; exec: boolean }>();

  constructor(private readonly options: ServerAgentToolsOptions) {}

  async isServerProject(cwd: string): Promise<boolean> {
    const answer = await this.options.list(cwd).then(
      ({ targets }) => ({ server: targets.length > 0, exec: targets.some((target) => target.protocol !== "ftp") }),
      () => ({ server: false, exec: false }),
    );
    this.known.set(cwd, answer);
    return answer.server;
  }

  /** Without an answer yet, a sftp.json in the checkout itself counts. */
  knownServerProject(cwd: string): boolean {
    return this.known.get(cwd)?.server ?? existsSync(join(cwd, SFTP_JSON_PATH));
  }

  private async resolve(cwd: string, ref: unknown): Promise<Resolved> {
    const { project, targets } = await this.options.list(cwd);
    const wanted = text(ref);
    const usable = targets.filter((target) => target.usable);
    const found = wanted
      ? targets.find((target) => target.id === wanted) ?? targets.find((target) => labelOf(target).toLowerCase() === wanted.toLowerCase())
      : usable.length === 1 ? usable[0] : undefined;
    if (!found) {
      const names = targets.map((target) => `${labelOf(target)} (${target.id})`).join(", ");
      if (!targets.length) throw new Error("This project names no server: it has no .vscode/sftp.json.");
      throw new Error(wanted ? `No server "${wanted}" here. The servers are: ${names}.` : `Name the server: ${names}.`);
    }
    if (!found.usable) throw new Error(`${labelOf(found)} cannot be reached as sftp.json names it.`);
    return {
      target: found,
      key: { workspaceId: project.workspaceId, targetId: found.id },
      label: labelOf(found),
      address: formatAddress(found),
      localDir: found.context ? join(cwd, ...found.context.split("/")) : cwd,
    };
  }

  private mark(resolved: Resolved): string {
    return serverMarkLine(resolved.label, resolved.address);
  }

  private async levels(resolved: Resolved, threadId: string): Promise<{ targetLevel: TargetLevel; threadLevel?: TargetLevel }> {
    const [targetLevel, threadLevel] = await Promise.all([
      this.options.targetLevel(resolved.key),
      this.options.threadLevel(threadId).catch(() => undefined),
    ]);
    return threadLevel ? { targetLevel, threadLevel } : { targetLevel };
  }

  /** The request a server_exec or server_put_tmp call makes, for `decideServerCall`. */
  private async request(session: RuntimeSessionInfo, toolName: string, input: Record<string, unknown>): Promise<(ServerCallRequest & { refused?: string }) | undefined> {
    const tool = serverToolName(toolName);
    if (tool !== SERVER_TOOLS.exec && tool !== SERVER_TOOLS.putTmp) return undefined;
    const resolved = await this.resolve(session.cwd, input.target);
    const base = { target: { label: resolved.label, address: resolved.address }, ...(await this.levels(resolved, session.sessionId)) };
    if (tool === SERVER_TOOLS.exec) {
      if (resolved.target.protocol === "ftp") return { ...base, kind: "exec", command: String(input.command ?? ""), refused: noCommands(resolved.label) };
      return { ...base, kind: "exec", command: String(input.command ?? ""), where: input.cwd === "tmp" ? "~/tmp" : resolved.target.remotePath };
    }
    return { ...base, kind: "put-tmp", where: `~/tmp/${String(input.path ?? "")}` };
  }

  /**
   * The gate of one tool call: server_exec and server_put_tmp by the levels,
   * a local bash command that reaches a server like server_exec.
   */
  async gate(session: RuntimeSessionInfo, toolName: string, input: Record<string, unknown>, confirm: (title: string, message: string) => Promise<boolean>): Promise<{ block: true; reason: string } | undefined> {
    let request: ServerCallRequest | undefined;
    try {
      request = toolName === "bash" ? await this.bypassRequest(session, input) : await this.request(session, toolName, input);
    } catch {
      // An unknown target: the tool itself answers with the reason.
      return undefined;
    }
    if (!request) return undefined;
    return this.apply(verdictOf(request), toolName, confirm);
  }

  private async bypassRequest(session: RuntimeSessionInfo, input: Record<string, unknown>): Promise<ServerCallRequest | undefined> {
    const command = typeof input.command === "string" ? input.command : undefined;
    if (!command || !this.knownServerProject(session.cwd)) return undefined;
    const { project, targets } = await this.options.list(session.cwd);
    const found = serverBypassIn(command, targets.map((target) => ({ id: target.id, label: labelOf(target), host: target.host })));
    if (!found) return undefined;
    const target = targets.find((candidate) => candidate.id === found.target.id)!;
    const resolved: Resolved = { target, key: { workspaceId: project.workspaceId, targetId: target.id }, label: labelOf(target), address: formatAddress(target), localDir: session.cwd };
    return { kind: "bypass", target: { label: resolved.label, address: resolved.address }, command, tool: found.tool, ...(found.remoteCommand ? { remoteCommand: found.remoteCommand } : {}), ...(await this.levels(resolved, session.sessionId)) };
  }

  private async apply(verdict: ServerVerdict, toolName: string, confirm: (title: string, message: string) => Promise<boolean>): Promise<{ block: true; reason: string } | undefined> {
    if (verdict.kind === "allow") return undefined;
    if (verdict.kind === "block") {
      this.options.log?.("servers.agent.blocked", `${toolName}: ${verdict.reason}`);
      return { block: true, reason: verdict.reason };
    }
    if (await confirm(verdict.title, verdict.message)) return undefined;
    const reason = `Blocked by Tau: the user did not allow ${toolName === "bash" ? "this command on the server" : toolName}.`;
    this.options.log?.("servers.agent.blocked", `${toolName}: not approved`);
    return { block: true, reason };
  }

  /** The tool refuses what the gate would refuse, should a door have been skipped. */
  private async refuseBlocked(session: RuntimeSessionInfo, toolName: string, input: Record<string, unknown>): Promise<void> {
    const request = await this.request(session, toolName, input);
    const verdict = request ? verdictOf(request) : undefined;
    if (verdict?.kind === "block") throw new Error(verdict.reason);
  }

  /** The tools a thread sees; server_exec only where a target may run commands (FTP never does). */
  tools(session: RuntimeSessionInfo): HostMcpTool[] {
    const offered = this.allTools(session);
    return this.known.get(session.cwd)?.exec === false ? offered.filter((tool) => tool.name !== SERVER_TOOLS.exec) : offered;
  }

  private allTools(session: RuntimeSessionInfo): HostMcpTool[] {
    const cwd = session.cwd;
    const connect = async (resolved: Resolved) => this.options.transport({ cwd, targetId: resolved.target.id });
    return [
      {
        name: SERVER_TOOLS.status,
        label: "Server status",
        description: "Lists this project's server targets: address, folder, what the agent may run there, files not uploaded yet and changes on the server since Tau last read it. Read only.",
        promptSnippet: "server_status: the project's servers, what is not uploaded yet, what changed there",
        parameters: Type.Object({}),
        execute: async () => {
          const status = await this.options.status({ cwd });
          const { targets } = await this.options.list(cwd);
          const threadLevel = await this.options.threadLevel(session.sessionId).catch(() => undefined);
          const lines = await Promise.all(status.targets.map(async (row) => {
            const target = targets.find((candidate) => candidate.id === row.targetId);
            const level = row.level;
            const effective = stricterLevel(level, threadLevel);
            const commands = { "read-only": "refused", ask: "ask the user first", full: "run without asking" }[effective];
            const pending = row.pending.slice(0, 30).map((file) => `    ${file.change} ${file.path}${file.blocked ? " (blocked)" : ""}${file.credentials ? " (holds credentials)" : ""}`);
            const drift = (row.drift ?? []).slice(0, 30).map((file) => `    ${file.change} ${file.path}`);
            return [
              `- ${row.label} (id ${row.targetId}): ${row.address}`,
              `  local folder: ${row.context || "."} · state: ${row.state}${row.unreachable ? ` (${row.unreachable})` : ""}${target?.protocol === "ftp" ? " · FTP: runs no commands" : row.caps && !row.caps.exec ? " · no shell (server_exec unavailable)" : ""}`,
              `  commands on the server: ${commands}${effective !== level ? " (this thread's level)" : ""} · Git there: read only`,
              `  not uploaded: ${row.pendingTotal}${pending.length ? `\n${pending.join("\n")}` : ""}`,
              ...(row.drift ? [`  changed on the server since Tau last read it: ${row.drift.length}${drift.length ? `\n${drift.join("\n")}` : ""}`] : []),
            ].join("\n");
          }));
          return result(lines.length ? `Servers of this project:\n${lines.join("\n")}` : "This project names no server.");
        },
      },
      {
        name: SERVER_TOOLS.list,
        label: "List a server folder",
        description: "Lists a folder on the server: the site's folder (path relative to it, empty for the folder itself) or ~/tmp. Read only.",
        parameters: Type.Object({ path: Type.Optional(Type.String({ description: "Relative to the site's folder, or ~/tmp/…; empty for the site's folder." })), target: TARGET_PARAM }),
        execute: async (_id: string, params: unknown) => {
          const input = record(params);
          const resolved = await this.resolve(cwd, input.target);
          const path = serverPath(input.path, true);
          const fs = await connect(resolved);
          const entries = (await fs.list(path, { area: "any" })).sort((a, b) => (a.name < b.name ? -1 : 1));
          const shown = entries.slice(0, LIST_CAP).map((entry) => `${entry.type === "directory" ? "d" : entry.type === "symlink" ? "l" : "-"} ${entry.mode.toString(8).padStart(4, "0")} ${String(entry.size).padStart(9)} ${new Date(entry.mtime * 1000).toISOString().slice(0, 16)} ${entry.name}${entry.type === "directory" ? "/" : ""}`);
          const more = entries.length > LIST_CAP ? `\n… ${entries.length - LIST_CAP} more` : "";
          return result(`${this.mark(resolved)}\n${path || resolved.target.remotePath}:\n${shown.join("\n") || "(empty)"}${more}`);
        },
      },
      {
        name: SERVER_TOOLS.read,
        label: "Read a server file",
        description: "Reads a file on the server, below the site's folder (path relative to it) or ~/tmp. Read only; .git is never read.",
        parameters: Type.Object({ path: Type.String({ description: "Relative to the site's folder, or ~/tmp/…" }), target: TARGET_PARAM }),
        execute: async (_id: string, params: unknown) => {
          const input = record(params);
          const resolved = await this.resolve(cwd, input.target);
          const path = serverPath(input.path, true);
          if (!path) throw new Error("Name a file.");
          const fs = await connect(resolved);
          const data = await fs.read(path, { area: "any" });
          if (isBinary(data)) return result(`${this.mark(resolved)}\n${path}: binary file, ${data.length} bytes.`);
          const shown = cap(data.toString("utf8"), READ_CAP);
          return result(`${this.mark(resolved)}\n${path} (${data.length} bytes)\n${shown.text}${shown.truncated ? `\n… cut at ${READ_CAP} bytes` : ""}`);
        },
      },
      {
        name: SERVER_TOOLS.diff,
        label: "Diff local and server",
        description: "Compares local files with the same files on the server as they are now (paths relative to the site's folder); `-` lines are the server's, `+` lines the local ones. Read only.",
        parameters: Type.Object({ paths: Type.Array(Type.String(), { description: `Up to ${DIFF_PATHS_CAP} paths relative to the site's folder.` }), target: TARGET_PARAM }),
        execute: async (_id: string, params: unknown) => {
          const input = record(params);
          const resolved = await this.resolve(cwd, input.target);
          const paths = (Array.isArray(input.paths) ? input.paths : []).slice(0, DIFF_PATHS_CAP).map(projectPath);
          if (!paths.length) throw new Error("Name at least one path.");
          const fs = await connect(resolved);
          const mirror = new Mirror(this.options.mirrorDir(resolved.key), { git: this.options.git });
          await mirror.ensure();
          const sections: string[] = [];
          for (const path of paths) {
            // oxlint-disable-next-line no-await-in-loop -- one file at a time over the one connection
            const server = await fs.read(path, { area: "project" }).catch((error: unknown) => (/no such file/iu.test(message(error)) ? undefined : Promise.reject(error)));
            // oxlint-disable-next-line no-await-in-loop
            const local = await readLocalFile(resolved.localDir, path);
            if (!server && !local) { sections.push(`${path}: on neither side.`); continue; }
            // oxlint-disable-next-line no-await-in-loop
            const [before, after] = await Promise.all([server ? mirror.writeBlob(server) : undefined, local ? mirror.writeBlob(local.data) : undefined]);
            const state = !server ? " (only local)" : !local ? " (only on the server)" : "";
            // oxlint-disable-next-line no-await-in-loop
            sections.push(`--- server/${path}\n+++ local/${path}${state}\n${patchText(await diffBlobs(this.options.git, mirror, path, before, after))}`);
          }
          return result(`${this.mark(resolved)}\n${sections.join("\n\n")}`);
        },
      },
      {
        name: SERVER_TOOLS.exec,
        label: "Run on the server",
        description: "Runs a shell command on the server, in the site's folder (cwd \"project\") or in ~/tmp (cwd \"tmp\"). Depending on the user's settings it asks the user first, runs, or is refused. Git on the server is read-only: writing Git subcommands are refused. Never use it to upload or change the site's files: propose an upload with server_propose_upload.",
        promptSnippet: "server_exec: run a command on the project's server (asks the user unless they allowed it)",
        parameters: Type.Object({
          command: Type.String({ description: "The shell command, run by /bin/sh on the server." }),
          cwd: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("tmp")], { description: "\"project\" (default): the site's folder; \"tmp\": ~/tmp." })),
          timeoutSeconds: Type.Optional(Type.Number({ description: `Default ${DEFAULT_TIMEOUT_S}, at most ${MAX_TIMEOUT_S}.` })),
          target: TARGET_PARAM,
        }),
        execute: async (_id: string, params: unknown, signal?: AbortSignal) => {
          const input = record(params);
          const command = text(input.command);
          if (!command) throw new Error("Name the command.");
          await this.refuseBlocked(session, SERVER_TOOLS.exec, input);
          const resolved = await this.resolve(cwd, input.target);
          const fs = await connect(resolved);
          if (!fs.exec) throw new Error(`${resolved.label} offers no shell (SFTP or FTP only), so commands cannot run there.`);
          const where = input.cwd === "tmp" ? "tmp" : "project";
          const seconds = Math.min(MAX_TIMEOUT_S, Math.max(1, typeof input.timeoutSeconds === "number" ? Math.round(input.timeoutSeconds) : DEFAULT_TIMEOUT_S));
          const run = await fs.exec(serverExecCommand(command), { cwd: where, timeoutMs: seconds * 1000, maxOutputBytes: OUTPUT_CAP, ...(signal ? { signal } : {}) });
          const status = run.timedOut ? `timed out after ${seconds} s` : run.signal ? `ended by ${run.signal}` : `exit ${run.code ?? "?"}`;
          const parts = [
            `${this.mark(resolved)} ${where === "tmp" ? "~/tmp" : resolved.target.remotePath}`,
            `$ ${command}`,
            status,
            run.stdout ? run.stdout.replace(/\n$/u, "") : "",
            run.stderr ? `[stderr]\n${run.stderr.replace(/\n$/u, "")}` : "",
            run.truncated ? `… output cut at ${OUTPUT_CAP} bytes per stream` : "",
          ];
          return result(parts.filter(Boolean).join("\n"));
        },
      },
      {
        name: SERVER_TOOLS.putTmp,
        label: "Write to ~/tmp on the server",
        description: "Writes one file below ~/tmp on the server, from `content` or from a local file of the project (`localPath`), e.g. a script to try there with server_exec. Never writes the site's folder. Asks the user first unless they allowed it.",
        parameters: Type.Object({
          path: Type.String({ description: "Relative to ~/tmp, e.g. probe.php." }),
          content: Type.Optional(Type.String({ description: "The file's text." })),
          localPath: Type.Optional(Type.String({ description: "A file of the local project to copy instead, relative to the target's local folder." })),
          target: TARGET_PARAM,
        }),
        execute: async (_id: string, params: unknown) => {
          const input = record(params);
          await this.refuseBlocked(session, SERVER_TOOLS.putTmp, input);
          const resolved = await this.resolve(cwd, input.target);
          const relative = text(input.path)?.replace(/^~\/tmp\/+/u, "").replace(/^\.\/+/u, "");
          if (!relative || !isSyncPath(relative)) throw new Error("Name a path relative to ~/tmp.");
          let data: Buffer;
          if (typeof input.content === "string") data = Buffer.from(input.content);
          else if (text(input.localPath)) {
            const local = await readLocalFile(resolved.localDir, projectPath(input.localPath));
            if (!local) throw new Error(`${String(input.localPath)} is no file of the local folder.`);
            data = local.data;
          } else throw new Error("Pass content or localPath.");
          if (data.length > PUT_CAP) throw new Error(`At most ${PUT_CAP} bytes.`);
          const fs = await connect(resolved);
          // Folders below ~/tmp first; the area keeps every step inside it.
          const parts = relative.split("/");
          for (let depth = 1; depth < parts.length; depth++) {
            const dir = `~/tmp/${parts.slice(0, depth).join("/")}`;
            // oxlint-disable-next-line no-await-in-loop -- each folder needs its parent
            const exists = await fs.stat(dir, { area: "tmp" }).then((info) => info.type === "directory", () => false);
            // oxlint-disable-next-line no-await-in-loop
            if (!exists) await fs.mkdir(dir, { area: "tmp", mode: 0o700 });
          }
          await fs.write(`~/tmp/${relative}`, data, { area: "tmp", mode: 0o600 });
          return result(`${this.mark(resolved)}\nWrote ~/tmp/${relative} (${data.length} bytes).`);
        },
      },
      {
        name: SERVER_TOOLS.proposeUpload,
        label: "Propose an upload",
        description: "Proposes uploading local changes to the server. It uploads nothing: the user sees a card with the files, what the server holds now and an Upload button, and decides. Leave files out to propose every change the upload list chooses by default; files holding live credentials are left for the user to pick in the server view.",
        promptSnippet: "server_propose_upload: show the user an upload card for local changes; only the user uploads",
        parameters: Type.Object({
          files: Type.Optional(Type.Array(Type.String(), { description: "Paths relative to the site's folder; every pending change chosen by default when left out." })),
          note: Type.Optional(Type.String({ description: "One or two sentences for the user: what the change does and how you tested it." })),
          target: TARGET_PARAM,
        }),
        execute: async (_id: string, params: unknown) => {
          const input = record(params);
          const resolved = await this.resolve(cwd, input.target);
          const status = await this.options.status({ cwd });
          const row = status.targets.find((candidate) => candidate.targetId === resolved.target.id);
          const pending = row?.pending ?? [];
          const named = Array.isArray(input.files) ? input.files.map(projectPath) : undefined;
          const leftOut: UploadProposal["leftOut"] = [];
          let chosen: PendingUploadRow[];
          if (named) {
            const byPath = new Map(pending.map((file) => [file.path, file]));
            chosen = [];
            for (const path of new Set(named)) {
              const file = byPath.get(path);
              if (!file) leftOut.push({ path, reason: "nothing to upload: the server already has this state, or the path is ignored" });
              else if (file.credentials) leftOut.push({ path, reason: `holds live credentials (${file.credentials.join(", ")}); the user picks it in the server view if they mean to` });
              else chosen.push(file);
            }
          } else {
            chosen = pending.filter((file) => file.selected);
            for (const file of pending) if (!file.selected && file.credentials) leftOut.push({ path: file.path, reason: `holds live credentials (${file.credentials.join(", ")})` });
          }
          const ops = { added: "add", modified: "modify", deleted: "delete" } as const;
          const preview: DeployPreview = chosen.length
            ? await this.options.preview({ cwd, targetId: resolved.target.id, files: chosen.map((file) => ({ path: file.path, op: ops[file.change] })) })
            : { targetId: resolved.target.id, files: [], kept: [], warnings: [] };
          const writes = preview.files.filter((file) => file.outcome === "upload" || file.outcome === "delete").length;
          const note = text(input.note)?.slice(0, 2000);
          const proposal: UploadProposal = {
            kind: "server-upload-proposal",
            workspace: cwd,
            threadId: session.sessionId,
            target: { id: resolved.target.id, label: resolved.label, address: resolved.address },
            ...(note ? { note } : {}),
            files: preview.files,
            kept: named ? [] : preview.kept,
            warnings: preview.warnings,
            leftOut,
            message: writes
              ? `Nothing was uploaded. The user now sees a card proposing ${writes} ${writes === 1 ? "file" : "files"} for ${resolved.label} with an Upload button; only their click uploads. Do not say the files are on the server.`
              : `Nothing was uploaded, and nothing in this proposal would change the server${preview.files.length ? " (see each file's outcome)" : ""}.`,
          };
          return result(`${this.mark(resolved)}\n${JSON.stringify(proposal, null, 2)}`);
        },
      },
    ];
  }
}

/**
 * Registers the tools, their gate and the instructions: Pi through a runtime
 * extension, every other runtime through the MCP endpoint. Only threads of a
 * server project get them.
 */
export function registerServerAgentTools(context: HostExtensionContext, agent: ServerAgentTools): () => void {
  const { services } = context;
  const pi = services.registerRuntimeExtension("tau-servers-tools", async (api, session) => {
    if (!(await agent.isServerProject(session.cwd))) return;
    for (const tool of agent.tools(session)) api.registerTool(tool);
    api.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${SERVER_INSTRUCTIONS}` }));
    api.on("tool_call", (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | undefined> => agent.gate(
      session,
      event.toolName,
      event.input as Record<string, unknown>,
      (title, body) => ctx.ui.confirm(title, body, { signal: ctx.signal }),
    ));
  });
  const disposers = [
    pi,
    services.mcp.registerTools((thread) => (agent.knownServerProject(thread.cwd) ? agent.tools(thread) : [])),
    services.mcp.gate((call) => (serverToolName(call.toolName)
      ? agent.gate({ sessionId: call.threadId, cwd: call.cwd }, call.toolName, call.input, call.confirm)
      : undefined)),
    services.mcp.registerInstructions?.((thread) => (agent.knownServerProject(thread.cwd) ? SERVER_INSTRUCTIONS : undefined)) ?? (() => undefined),
    // The MCP door asks synchronously; learn a checkout's answer before its threads connect.
    services.registerThreadLifecycle({
      beforeWorkspace: async (cwd) => { await agent.isServerProject(cwd); },
      beforeOpen: async (session) => { await agent.isServerProject(session.cwd); },
    }),
  ];
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}

