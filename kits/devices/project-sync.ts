import type { ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { quote, stop, type Run } from "./process.js";

/** What the last sync sent, at the root of the remote copy. Prune deletes only files listed there. */
export const SYNC_MANIFEST = ".tau-sync.json";
export const SYNC_LIMITS = { files: 100_000, bytes: 2 * 1024 ** 3, listTimeout: 60_000, transferTimeout: 15 * 60_000, pruneTimeout: 120_000 };
const SSH_OPTIONS = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];

/** `<remoteDirectory>/projects/<name>-<8 hex of sha256(absolute path)>`: two projects with one name stay apart. */
export function remoteProjectPath(remoteDirectory: string, projectPath: string): string {
  const absolute = resolve(projectPath);
  const name = basename(absolute).replace(/[^a-zA-Z0-9 _.@+-]/g, "_") || "project";
  return `${remoteDirectory.replace(/\/+$/, "")}/projects/${name}-${createHash("sha256").update(absolute).digest("hex").slice(0, 8)}`;
}

/**
 * Runs on the device machine as `node -e PRUNE_SCRIPT <root>` with `{ files }` on stdin.
 * Deletes what the previous manifest listed and the new list does not, then
 * replaces the manifest. Anything the previous sync did not send (node_modules,
 * Pods, build output) is never touched; nor is a path that leaves the root.
 * No backslashes, so any login shell keeps it intact inside single quotes.
 */
export const PRUNE_SCRIPT = `const fs = require("fs"), path = require("path");
const root = path.resolve(process.argv[1]);
const manifest = path.join(root, ${JSON.stringify(SYNC_MANIFEST)});
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const next = JSON.parse(Buffer.concat(chunks).toString("utf8")).files;
  if (!Array.isArray(next) || next.some((file) => typeof file !== "string")) throw new Error("Invalid project file list.");
  let previous = [];
  try { const old = JSON.parse(fs.readFileSync(manifest, "utf8")); if (Array.isArray(old.files)) previous = old.files; } catch {}
  const keep = new Set(next), realRoot = fs.realpathSync(root);
  let removed = 0;
  for (const file of previous) {
    if (typeof file !== "string" || !file || keep.has(file) || path.isAbsolute(file) || file.split("/").some((part) => part === ".." || part === "") || file.includes(String.fromCharCode(92)) || file === ${JSON.stringify(SYNC_MANIFEST)}) continue;
    let parent;
    try { parent = fs.realpathSync(path.dirname(path.join(root, file))); } catch { continue; }
    if (parent !== realRoot && !parent.startsWith(realRoot + path.sep)) continue;
    const target = path.join(parent, path.basename(file));
    try { if (fs.lstatSync(target).isDirectory()) continue; fs.unlinkSync(target); removed++; } catch {}
  }
  fs.writeFileSync(manifest + ".pending", JSON.stringify({ version: 1, files: next }));
  fs.renameSync(manifest + ".pending", manifest);
  process.stdout.write(JSON.stringify({ removed }));
});`;

/** The files Git lists for the folder (tracked and untracked, ignored ones excluded) that exist as files or links. */
export async function listProjectFiles(execute: Run, projectPath: string): Promise<{ files: string[]; bytes: number }> {
  try { await execute("git", ["-C", projectPath, "rev-parse", "--is-inside-work-tree"], { timeout: SYNC_LIMITS.listTimeout }); }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (/not a git repository/i.test(reason)) throw new Error(`${projectPath} is not a Git repository. Project sync sends the files Git lists, tracked and untracked but not ignored; run git init there first.`, { cause: error });
    throw new Error(`Cannot list the project's files with Git: ${reason}`, { cause: error });
  }
  const { stdout } = await execute("git", ["-C", projectPath, "ls-files", "-co", "--exclude-standard", "-z"], { timeout: SYNC_LIMITS.listTimeout });
  const listed = [...new Set(stdout.split("\0").filter((file) => file && file !== SYNC_MANIFEST))];
  if (listed.length > SYNC_LIMITS.files) throw new Error(`The project lists ${listed.length} files; project sync sends at most ${SYNC_LIMITS.files}.`);
  const files: string[] = [];
  let bytes = 0;
  for (const file of listed) {
    // A tracked file deleted here is not sent, and prune removes the copy; a submodule is a folder and stays out.
    const stats = await lstat(join(projectPath, file)).catch(() => undefined);
    if (!stats || stats.isDirectory()) continue;
    files.push(file);
    if (stats.isFile()) bytes += stats.size;
    if (bytes > SYNC_LIMITS.bytes) throw new Error(`The project is larger than ${SYNC_LIMITS.bytes / 1024 ** 3} GiB; project sync refuses it.`);
  }
  return { files, bytes };
}

/** `ssh <alias> 'mkdir -p D && tar -xf - -C D'`: the extraction command, quoted for the remote login shell. */
export const extractCommand = (remotePath: string): string => `mkdir -p ${quote(remotePath)} && tar -xf - -C ${quote(remotePath)}`;
export const pruneCommand = (remotePath: string): string => `node -e ${quote(PRUNE_SCRIPT)} ${quote(remotePath)}`;

function finished(child: ChildProcess, label: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let stdout = "", stderr = "", done = false;
    child.stdout?.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-64_000); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4_000); });
    child.on("error", (error) => { if (!done) { done = true; reject(new Error(`${label}: ${error.message}`)); } });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      if (code === 0) resolvePromise(stdout); else reject(new Error(`${label}: ${stderr.trim() || `exited ${String(code)}`}`));
    });
  });
}
/** Settles with the children, stopping every one on failure, timeout or cancel. */
async function settle(children: ChildProcess[], work: Promise<unknown>, timeout: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Project sync timed out.")), timeout);
    abort = () => reject(new Error("Project sync cancelled."));
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  });
  try { await Promise.race([work, limit]); }
  catch (error) { for (const child of children) stop(child); throw error; }
  finally { clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); }
}

export interface SyncInput { execute: Run; launch: typeof spawn; ssh: string; remoteDirectory: string; projectPath: string; signal?: AbortSignal }
/** Streams the listed files with tar over one ssh session, then prunes over a second. */
export async function syncProject(input: SyncInput): Promise<{ remotePath: string; files: number; bytes: number; removed: number }> {
  const { files, bytes } = await listProjectFiles(input.execute, input.projectPath);
  const remotePath = remoteProjectPath(input.remoteDirectory, input.projectPath);
  // `./` keeps a name that starts with a dash from reading as an option.
  const tar = input.launch("tar", ["-c", "-f", "-", "-C", input.projectPath, "--null", "-T", "-"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const remote = input.launch("ssh", [...SSH_OPTIONS, "--", input.ssh, extractCommand(remotePath)], { stdio: ["pipe", "pipe", "pipe"] });
  tar.stdin?.on("error", () => undefined);
  remote.stdin?.on("error", () => undefined);
  const sent = Promise.all([finished(tar, "tar"), finished(remote, "ssh")]);
  sent.catch(() => undefined);
  if (remote.stdin) tar.stdout?.pipe(remote.stdin);
  tar.stdin?.end(files.map((file) => `./${file}\0`).join(""));
  await settle([tar, remote], sent, SYNC_LIMITS.transferTimeout, input.signal);
  const prune = input.launch("ssh", [...SSH_OPTIONS, "--", input.ssh, pruneCommand(remotePath)], { stdio: ["pipe", "pipe", "pipe"] });
  prune.stdin?.on("error", () => undefined);
  const pruned = finished(prune, "ssh");
  pruned.catch(() => undefined);
  prune.stdin?.end(JSON.stringify({ files }));
  await settle([prune], pruned, SYNC_LIMITS.pruneTimeout, input.signal);
  let removed = 0;
  try { removed = Number((JSON.parse(await pruned) as { removed?: unknown }).removed) || 0; } catch { /* The files arrived; only the count is unknown. */ }
  return { remotePath, files: files.length, bytes, removed };
}

/** A command the agent can run from this machine. With a forwarded port, Metro keeps running here. */
export function syncHint(ssh: string, remotePath: string, ports: readonly number[]): string {
  const directory = /^[a-zA-Z0-9_./@+-]+$/.test(remotePath) ? remotePath : quote(remotePath);
  if (!ports.length) return `Install dependencies and build on the device machine: ssh ${ssh} ${quote(`cd ${directory} && npm install && npx expo run:ios`)}. No port is forwarded, so the app uses a bundler on that machine; add Metro's port (8081) to this machine's forwarded ports in Settings → Simulators to keep Metro here.`;
  const metro = ports.includes(8081) ? 8081 : ports[0]!;
  return `Keep Metro running here (npx expo start --port ${metro}); the device machine reaches it on its own 127.0.0.1:${metro}. Then build and launch there: ssh ${ssh} ${quote(`cd ${directory} && npm install && npx expo run:ios --no-bundler --port ${metro}`)}`;
}
