import { execFile } from "node:child_process";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { gitEnvironment, gitExecutable, HostCommandError, resolveProjectIcon, type HostExtensionContext, type UiSession } from "tau/host-extension";
import { isScratchAllocation, promotionFile, readPromotedProject } from "./project-starts.js";
import type { ProjectPromotionInfo, ProjectPromotionResult } from "./protocol.js";

const execute = promisify(execFile);
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);

export function promotionName(value: string): string {
  const name = value.trim().normalize("NFC");
  // oxlint-disable-next-line eslint/no-control-regex -- A display name cannot contain control characters.
  if (!name || name.length > 60 || /[\x00-\x1f\x7f]/u.test(name)) throw new HostCommandError("Choose a project name with 1 to 60 characters.");
  return name;
}

/** One host transaction for names and folders, shared by every device and profile. */
export function registerProjectPromotion(context: HostExtensionContext, options: { invalidate(path: string): void; running(path: string, asking: string): Promise<unknown[]> }) {
  const { services } = context;
  let queue = Promise.resolve();
  const index = async () => {
    const update = await services.sessions.refreshIndex({ requireComplete: true });
    if (update.type !== "thread-index") throw new HostCommandError("This machine could not read its thread index.");
    return update.index;
  };
  const inputOf = (input: unknown) => {
    const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
    if (typeof raw.workspace !== "string" || !raw.workspace || typeof raw.sessionId !== "string" || !raw.sessionId) throw new HostCommandError("Choose an existing thread and its workspace.");
    return { workspace: raw.workspace, sessionId: raw.sessionId, name: raw.name, git: raw.git === true };
  };
  const target = async (input: ReturnType<typeof inputOf>, sessions: readonly UiSession[]) => {
    let path: string;
    try {
      path = await services.knownWorkspacePath(input.workspace);
      if (!(await stat(path)).isDirectory()) throw new HostCommandError("missing");
      path = await realpath(path);
    } catch { throw new HostCommandError("This thread's folder no longer exists."); }
    const thread = sessions.find((session) => session.id === input.sessionId);
    if (!thread || thread.backendKind === "machine" || !await sameFolder(thread.projectPath, path)) throw new HostCommandError("The thread does not belong to this folder on this machine.");
    if (!isScratchAllocation(services.stateDir, path)) throw new HostCommandError("Only a private thread folder can become a project.");
    return { path, thread };
  };
  const info = async (input: ReturnType<typeof inputOf>): Promise<ProjectPromotionInfo> => {
    const all = await index();
    const { path, thread } = await target(input, all.sessions);
    const otherThreads = (await Promise.all(all.sessions.filter((entry) => entry.id !== thread.id && entry.backendKind !== "machine").map(async (entry) => await sameFolder(entry.projectPath, path) ? 1 : 0))).reduce((sum: number, n) => sum + n, 0);
    return { workspace: services.workspaceRef(path), title: thread.title, otherThreads, promoted: Boolean(readPromotedProject(services.stateDir, path)) };
  };
  context.registerCommand("promotion-info", async (input) => {
    try { return await info(inputOf(input)); }
    catch (error) { throw new HostCommandError(failure(error)); }
  }, { access: "read" });
  context.registerCommand("promote-scratch", (raw) => {
    const work = queue.then(() => services.sessions.exclusive(async (): Promise<ProjectPromotionResult> => {
      if (!services.refreshProject) throw new HostCommandError("Update this machine to turn threads into projects.");
      const input = inputOf(raw);
      if (typeof input.name !== "string" || (raw as Record<string, unknown>).git !== undefined && typeof (raw as Record<string, unknown>).git !== "boolean") throw new HostCommandError("Choose a project name and Git option.");
      const name = promotionName(input.name);
      const all = await index();
      const { path } = await target(input, all.sessions);
      const existing = readPromotedProject(services.stateDir, path);
      if (existing) {
        if (existing.name !== name) throw new HostCommandError("This folder is already a project.");
        await services.refreshProject(path);
        options.invalidate(path);
        await services.sessions.refreshIndex({ publish: true }).catch((error: unknown) => services.log("project-promotion.publish-failed", failure(error)));
        return { workspace: services.workspaceRef(path), name };
      }
      // Check persisted registrations as well as all runtime-owned thread rows.
      const registrations = (await readdir(join(services.stateDir, "scratch"), { withFileTypes: true })).flatMap((entry) => {
        const stored = entry.isDirectory() ? readPromotedProject(services.stateDir, join(services.stateDir, "scratch", entry.name)) : undefined;
        return stored ? [stored] : [];
      });
      const remoteWorkspaces = new Set(all.sessions.filter((entry) => entry.backendKind === "machine").map((entry) => entry.workspaceId));
      const localProjects = all.projects.filter((project) => !project.workspaceId || !remoteWorkspaces.has(project.workspaceId));
      for (const project of [...registrations, ...localProjects, ...all.sessions.filter((session) => !session.projectless && session.backendKind !== "machine").map((session) => ({ path: session.projectPath, name: session.projectName }))]) {
        if (project.name.normalize("NFC").toLowerCase() === name.toLowerCase() && !await sameFolder(project.path, path)) throw new HostCommandError(`A project named "${name}" already exists.`);
      }
      const running = async () => {
        const streaming = all.sessions.filter((entry) => entry.backendKind !== "machine").some((entry) => services.thread(entry.id)?.cwd === path && services.thread(entry.id)?.isStreaming());
        return streaming || (await options.running(path, input.sessionId)).length > 0;
      };
      if (input.git && await running()) throw new HostCommandError("Stop the threads in this folder before starting Git, or turn it into a project without Git.");
      const marker = promotionFile(services.stateDir, path);
      const created: Array<{ path: string; text: string }> = [];
      let ownsGit = false;
      let ownsMarker = false;
      try {
        // Keep existing branding and configuration, including symlinks. Create only absent files.
        if (!await resolveProjectIcon(path)) {
          const hasConfig = await exists(join(path, "t3.json"));
          // A supported icon filename works without rewriting an existing t3.json.
          const iconName = hasConfig || await exists(join(path, "project-icon.svg")) ? "icon.svg" : "project-icon.svg";
          const icon = join(path, iconName);
          if (!await exists(icon)) {
            const letters = name.replace(/[^a-z0-9]/giu, "").slice(0, 2).toUpperCase() || "PR";
            let hash = 0;
            for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
            const text = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="hsl(${hash % 360} 48% 38%)"/><text x="32" y="41" text-anchor="middle" font-family="sans-serif" font-size="25" font-weight="700" fill="white">${letters}</text></svg>\n`;
            await writeFile(icon, text, { flag: "wx" });
            created.push({ path: icon, text });
            if (!hasConfig) {
              const config = { path: join(path, "t3.json"), text: JSON.stringify({ iconPath: iconName }, null, 2) + "\n" };
              await writeFile(config.path, config.text, { flag: "wx" });
              created.push(config);
            }
          }
        }
        if (input.git) {
          const git = gitExecutable();
          // Refuse inherited repositories and every existing .git, including files and symlinks.
          const inherited = await execute(git, ["rev-parse", "--show-toplevel"], { cwd: path, env: gitEnvironment(), timeout: 10_000 }).then(() => true, (error: unknown) => {
            if ((error as { code?: unknown }).code === 128) return false;
            throw error;
          });
          if (inherited || await exists(join(path, ".git"))) throw new HostCommandError("This folder already belongs to a Git repository. Turn it into a project without starting Git.");
          if (await running()) throw new HostCommandError("A thread started working in this folder. Stop it before starting Git.");
          await mkdir(join(path, ".git")); // Atomic refusal: never overwrite someone else's metadata.
          ownsGit = true;
          const run = (args: string[]) => execute(git, args, { cwd: path, env: gitEnvironment(), timeout: 30_000 });
          await run(["init", "--initial-branch=main"]);
          await run(["add", "--all"]);
          await run(["-c", "core.hooksPath=" + join(path, ".git", "tau-empty-hooks"), "commit", "--allow-empty", "-m", "Initial commit"]);
        }
        await mkdir(dirname(marker), { recursive: true, mode: 0o700 });
        await publishMarker(marker, JSON.stringify({ version: 1, path, name }) + "\n");
        ownsMarker = true;
        await services.refreshProject(path);
      } catch (error) {
        const rollbackErrors: string[] = [];
        const undo = async (action: () => Promise<unknown>) => {
          try { await action(); } catch (reason) { rollbackErrors.push(failure(reason)); }
        };
        if (ownsMarker) await undo(() => rm(marker));
        if (ownsGit) await undo(() => rm(join(path, ".git"), { recursive: true }));
        // Never remove a file that a running thread changed after we created it.
        for (const file of created.reverse()) if (await readFile(file.path, "utf8").catch(() => undefined) === file.text) await undo(() => rm(file.path));
        if (ownsMarker) {
          await undo(() => services.refreshProject!(path));
          await undo(() => services.sessions.refreshIndex({ publish: true }));
        }
        options.invalidate(path);
        throw new HostCommandError(failure(error) + (rollbackErrors.length ? ` Rollback could not finish: ${rollbackErrors.join("; ")}` : ""));
      }
      options.invalidate(path);
      // Registration is committed. A failed publication must not undo a successful durable operation.
      await services.sessions.refreshIndex({ publish: true }).catch((error: unknown) => services.log("project-promotion.publish-failed", failure(error)));
      return { workspace: services.workspaceRef(path), name };
    }));
    queue = work.then(() => undefined, () => undefined);
    return work.catch((error: unknown) => { throw new HostCommandError(failure(error)); });
  }, { long: true });
}

const exists = (path: string) => lstat(path).then(() => true, (error: unknown) => {
  if ((error as { code?: string }).code === "ENOENT") return false;
  throw error;
});
const sameFolder = async (left: string, right: string) => await realpath(left).catch(() => undefined) === right;

/** Publish a complete, flushed marker with atomic collision refusal. */
async function publishMarker(path: string, text: string): Promise<void> {
  const pending = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(pending, "wx", 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await link(pending, path);
  } finally { await rm(pending, { force: true }).catch(() => undefined); }
}
