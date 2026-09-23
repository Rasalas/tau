import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  assertAllowedCloneSource,
  gitExecutable,
  HostCommandError,
  isWorkspaceRelativePath,
  type DiffLoadOptions,
  type FileNode,
  type HostExtension,
  type HostExtensionContext,
  type UiToolRun,
  type WorkspaceChangesQuery,
  type WorkspaceRef,
} from "tau/host-extension";
import * as workspaceGit from "./workspace-git.js";
import { GitCoordinator } from "./git-coordinator.js";
import { readBoundedFileContent, statFile, writeTextFile } from "./file-content.js";
import { defaultEditorProbe, editorCommand, FILE_MANAGER_ID, findInstalledEditors, launchEditor } from "./editors.js";
import { CHECKPOINT_EVENT, CLONE_PROGRESS_EVENT, isWorktreeSubmodules, PROJECT_SCRIPTS_HOST_EXTENSION_ID, WORKSPACE_HOST_EXTENSION_ID, type ProjectDefaults, type UiDirectoryListing } from "./protocol.js";
import { createBranchRequests } from "./branch-request.js";
import { readReviewRequestContext } from "./review-request-context.js";
import { createWorkspaceKitLifecycle } from "./host-lifecycle.js";
import { registerWorktreeStorage } from "./worktree-storage-host.js";
import { registerAppOpen } from "./app-open.js";
import { worktreeSetupCommand } from "./agent-worktrees.js";
import { createTurnStatsFile, turnStatOf } from "./turn-stats.js";
import { initWorktreeSubmodules } from "./worktree-submodules.js";
import { DefaultBranchPuller } from "./default-branch-pull.js";
import { CloneJobs } from "./clone-jobs.js";

const execFileAsync = promisify(execFile);
/** The kits built on this one; their host entries may call the commands that name them. */
const REVIEW_KIT_ID = "tau.review";
const FILES_KIT_ID = "tau.files";

/** `~` and `~/…` name the host's home folder; a setting typed by hand usually starts that way. */
export function expandHome(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "~") return homedir();
  return trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
}

export async function listDirectories(requested: string | undefined, identify: (path: string) => WorkspaceRef): Promise<UiDirectoryListing> {
  const candidate = requested?.trim() ? expandHome(requested) : homedir();
  if (!isAbsolute(candidate)) throw new Error("Choose an absolute folder path.");
  const path = await realpath(candidate);
  const entries = await readdir(path, { withFileTypes: true });
  return {
    path,
    workspace: identify(path),
    ...(dirname(path) !== path ? { parent: dirname(path) } : {}),
    directories: entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true })),
  };
}

export { repositoryFolderName } from "./clone-jobs.js";

/**
 * What a repository checks in about new threads. Nothing here is required, and
 * a malformed file is no error: the client's own defaults answer instead.
 */
export async function readProjectDefaults(project: string): Promise<ProjectDefaults> {
  try {
    const raw = JSON.parse(await readFile(join(project, ".tau", "project.json"), "utf8")) as Record<string, unknown>;
    const mode = raw.workspaceMode;
    const setup = raw.runOnWorktreeCreate;
    const worktreeDirectory = raw.worktreeDirectory;
    return {
      ...(mode === "current" || mode === "worktree" ? { workspaceMode: mode } : {}),
      ...(typeof setup === "string" && setup.trim() ? { runOnWorktreeCreate: setup.trim() } : {}),
      ...(typeof worktreeDirectory === "string" && worktreeDirectory.trim() ? { worktreeDirectory: worktreeDirectory.trim() } : {}),
      ...(isWorktreeSubmodules(raw.worktreeSubmodules) ? { worktreeSubmodules: raw.worktreeSubmodules } : {}),
    };
  } catch {
    return {};
  }
}

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "dist-electron", ".next"]);
const VISIBLE_DOT_DIRECTORIES = new Set([".pi", ".scratch"]);
const MAX_TREE_DEPTH = 4;
const MAX_TREE_ENTRIES = 320;

/** Nodes carry workspace-relative POSIX paths; a client never sees the host's own. */
export async function readFileTree(path: string, relative = "", depth = 0, budget = { count: 0 }): Promise<FileNode[]> {
  if (depth > MAX_TREE_DEPTH || budget.count > MAX_TREE_ENTRIES) return [];
  const entries = await readdir(path, { withFileTypes: true });
  const nodes: FileNode[] = [];
  for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
    if (budget.count++ > MAX_TREE_ENTRIES) break;
    if (entry.name.startsWith(".") && !VISIBLE_DOT_DIRECTORIES.has(entry.name)) continue;
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    nodes.push({
      name: entry.name,
      path: relative ? `${relative}/${entry.name}` : entry.name,
      kind: entry.isDirectory() ? "directory" : "file",
    });
  }
  return nodes;
}

// IPC input is untrusted; every command re-reads its fields.
const record = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" ? input as Record<string, unknown> : {};
const requiredString = (input: unknown, key: string): string => {
  const value = record(input)[key];
  if (typeof value !== "string" || !value) throw new Error(`Workspace command needs "${key}".`);
  return value;
};
const optionalString = (input: unknown, key: string): string | undefined => {
  const value = record(input)[key];
  return typeof value === "string" ? value : undefined;
};

/**
 * A file reference inside the workspace. `relPath` is the contract: an absolute
 * path or a `..` escape is refused here, before anything resolves it. The
 * legacy `path` key stays readable for one version, guarded as it always was.
 */
const optionalRelativePath = (input: unknown): string | undefined => {
  const relative = optionalString(input, "relPath");
  if (relative === undefined) return optionalString(input, "path");
  if (!isWorkspaceRelativePath(relative)) throw new Error("Name a file by its path inside the workspace.");
  return relative;
};

const relativePath = (input: unknown): string => {
  const value = optionalRelativePath(input);
  if (!value) throw new Error('Workspace command needs "relPath".');
  return value;
};

function invalidateAfterTool(git: GitCoordinator, tool: UiToolRun, cwd: string): void {
  const command = typeof tool.args.command === "string" ? tool.args.command : "";
  const mutatesGit = /\bgit\s+(?:checkout|switch|branch|reset|worktree|commit|merge|rebase|pull|fetch)\b/iu.test(command);
  if (tool.name === "edit" || tool.name === "write" || mutatesGit) {
    git.invalidate(cwd, mutatesGit ? ["status", "branch", "workspace"] : ["status", "workspace"]);
  }
}

/**
 * Workspace Kit's host entry: files, Git status and staging, commits, worktrees
 * and external editors. Everything here used to be a method on PiHost.
 */
export function createWorkspaceHostExtension(): HostExtension {
  return {
    id: WORKSPACE_HOST_EXTENSION_ID,
    name: "Workspace Kit",
    permissions: [
      "workspace:read",
      "workspace:write",
      "workspace:switch",
      "sessions",
      "runtime:extend",
      "process",
    ],
    activate(context: HostExtensionContext) {
      const { services } = context;
      // The kit owns the Git cache; core only learns project facts from it.
      const git = new GitCoordinator({ onSubprocess: () => services.noteSubprocess() });
      const labels = new Map<string, string | undefined>();
      // The worktrees Tau made, Settings → Storage and the cleanup sweep.
      // A branch's request comes from Review Kit, which knows the hosts; a squash or rebase merge is only known from it.
      const branchRequest = createBranchRequests((input) => context.invokeHostExtension(REVIEW_KIT_ID, "branch-request", input));
      const worktrees = registerWorktreeStorage(context, {
        removed: (repository) => git.invalidate(repository, ["branch", "status", "workspace"]),
        requestState: async (path) => (await branchRequest(path))?.state,
      });
      const noteFailure = (label: string) => (error: unknown) => services.log(label, error instanceof Error ? error.message : String(error));
      const cwd = () => services.cwd();
      // A command may name another workspace by id; without one it means the host's.
      const workspaceOf = (input: unknown) => optionalString(input, "workspace") ?? optionalString(input, "cwd") ?? cwd();
      const refreshedChanges = async (project: string) => {
        git.invalidate(project);
        return git.getChanges(project);
      };
      const stageThen = async (path: string, mutate: (project: string, path: string) => Promise<void>) => {
        const project = cwd();
        await workspaceGit.assertWorkspacePath(project, path);
        await mutate(project, path);
        return refreshedChanges(project);
      };

      /**
       * The project's own setup, run once in the new worktree. Project Scripts
       * owns it when it is on (scripts with `runOnWorktreeCreate`, the old
       * string among them) and draws its steps as a card; without it the old
       * string runs here as it always did. A setup that fails is reported and
       * does not undo the worktree.
       */
      const setupCall = (command: string, input: Record<string, unknown>) =>
        context.invokeHostExtension(PROJECT_SCRIPTS_HOST_EXTENSION_ID, command, input);
      const beginSetup = async (project: string, branch: string): Promise<string | undefined> => {
        try {
          const begun = await setupCall("worktree-setup-begin", { project, branch }) as { setupId?: unknown };
          return typeof begun?.setupId === "string" ? begun.setupId : undefined;
        } catch {
          return undefined;
        }
      };
      const runWorktreeSetup = async (project: string, worktree: string, setupId: string | undefined): Promise<void> => {
        try {
          await setupCall("worktree-created", { project, worktree, ...(setupId ? { setupId } : {}) });
          return;
        } catch (error) {
          services.log("git.worktree.setup-fallback", error instanceof Error ? error.message : String(error));
        }
        const { runOnWorktreeCreate } = await readProjectDefaults(project);
        if (!runOnWorktreeCreate) return;
        services.noteSubprocess();
        try {
          const setup = worktreeSetupCommand(runOnWorktreeCreate);
          await execFileAsync(setup.command, setup.args, {
            windowsVerbatimArguments: setup.windowsVerbatimArguments,
            windowsHide: true,
            cwd: worktree,
            timeout: 10 * 60 * 1000,
            maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, TAU_PROJECT_ROOT: project, TAU_WORKTREE_PATH: worktree },
          });
          services.log("git.worktree.setup", runOnWorktreeCreate);
        } catch (error) {
          services.log("git.worktree.setup-failed", error instanceof Error ? error.message : String(error));
        }
      };

      // `tau app <path>` from a terminal.
      registerAppOpen(context);
      // Project sources: browse, pick, clone. Opening the result is core's job.
      context.registerCommand("list-directories", (input) => listDirectories(optionalString(input, "path"), (path) => services.workspaceRef(path)));
      // The folder dialog waits on the user, well past the ordinary command timeout.
      context.registerCommand("pick-folder", async () => {
        const path = await services.pickDirectory();
        return path ? services.workspaceRef(path) : undefined;
      }, { long: true });
      // A clone is a job: progress and the end arrive as pushes, and it can be cancelled.
      const clones = new CloneJobs({
        git: gitExecutable(),
        identify: (path) => services.workspaceRef(path),
        onSubprocess: () => services.noteSubprocess(),
        emit: (snapshot) => {
          if (snapshot.phase !== "running") services.log(`git.clone.${snapshot.phase}`, snapshot.error ?? snapshot.destination);
          context.emit(CLONE_PROGRESS_EVENT, snapshot);
        },
      });
      context.registerCommand("clone-start", async (input) => {
        const url = assertAllowedCloneSource(requiredString(input, "repositoryUrl"));
        // A client without a folder picker (headless or remote host) names the parent itself.
        const namedParent = optionalString(input, "parentPath");
        const parent = namedParent?.trim()
          ? expandHome(namedParent)
          : await services.pickDirectory({
            buttonLabel: "Clone here",
            message: "Choose the parent folder for the cloned project",
            createDirectory: true,
          });
        if (!parent) return undefined;
        return clones.start(url, parent);
      }, { long: true });
      context.registerCommand("clone-cancel", (input) => clones.cancel(requiredString(input, "id")));
      context.registerCommand("clone-jobs", () => clones.list());
      context.registerCommand("clone-forget", (input) => { clones.forget(requiredString(input, "id")); });
      context.registerCommand("file-tree", async (input) => {
        const project = cwd();
        const relative = optionalRelativePath(input);
        if (relative) await workspaceGit.assertWorkspacePath(project, relative);
        return readFileTree(relative ? resolve(project, relative) : project, relative ?? "");
      });
      // A branch with a pull or merge request diffs against that request's base.
      const branchChanges = async (project: string, query: WorkspaceChangesQuery) => {
        const request = query.baseRef ? undefined : await branchRequest(project);
        if (!request) return workspaceGit.getBranchChanges(project, query);
        const baseRef = await workspaceGit.firstExistingRef(project, [`origin/${request.baseRef}`, request.baseRef]);
        const changes = await workspaceGit.getBranchChanges(project, baseRef ? { ...query, baseRef } : query);
        return { ...changes, request };
      };
      context.registerCommand("changes", async (input) => {
        const query = (record(input).query ?? {}) as WorkspaceChangesQuery;
        if (query.scope === "branch") return branchChanges(cwd(), query);
        return git.getChanges(cwd());
      }, { callers: [REVIEW_KIT_ID] });
      context.registerCommand("file-diff", async (input) => {
        const project = cwd();
        const path = relativePath(input);
        await workspaceGit.assertWorkspacePath(project, path);
        return workspaceGit.getFileDiff(project, path, record(input).options as DiffLoadOptions | undefined);
      }, { callers: [REVIEW_KIT_ID] });
      context.registerCommand("stage-file", (input) => stageThen(relativePath(input), workspaceGit.stageFile));
      context.registerCommand("unstage-file", (input) => stageThen(relativePath(input), workspaceGit.unstageFile));
      context.registerCommand("revert-file", (input) => stageThen(relativePath(input), workspaceGit.revertFile));
      context.registerCommand("stage-all", async () => {
        const project = cwd();
        await workspaceGit.stageAll(project);
        return refreshedChanges(project);
      });
      context.registerCommand("read-file", async (input) => {
        const project = cwd();
        const path = relativePath(input);
        await workspaceGit.assertWorkspacePath(project, path);
        return readBoundedFileContent(resolve(project, path));
      }, { callers: [FILES_KIT_ID] });
      context.registerCommand("file-stat", async (input) => {
        const project = cwd();
        const path = relativePath(input);
        await workspaceGit.assertWorkspacePath(project, path);
        return statFile(resolve(project, path));
      }, { callers: [FILES_KIT_ID] });
      // An editor's save: refused as a conflict when the file changed since `expectedMtimeMs`.
      context.registerCommand("write-file", async (input) => {
        const project = cwd();
        const path = relativePath(input);
        const fields = record(input);
        if (typeof fields.text !== "string") throw new HostCommandError('Workspace command needs "text".');
        const expected = fields.expectedMtimeMs;
        if (expected !== undefined && expected !== null && typeof expected !== "number") throw new HostCommandError('"expectedMtimeMs" is a number.');
        await workspaceGit.assertWorkspacePath(project, path);
        const result = await writeTextFile(resolve(project, path), fields.text, expected as number | null | undefined);
        if (result.status === "written") {
          git.invalidate(project, ["status", "workspace"]);
          services.log("workspace.file-written", path);
        }
        return result;
      }, { callers: [FILES_KIT_ID] });
      context.registerCommand("commit", async (input) => {
        const project = cwd();
        const message = requiredString(input, "message");
        const push = record(input).push === true;
        try {
          const result = await workspaceGit.commit(project, message, push, refreshedChanges);
          git.invalidate(project);
          services.log("git.commit", result.detail);
          return result;
        } catch (error) {
          git.invalidate(project);
          throw error;
        }
      });
      context.registerCommand("pull", async () => {
        const project = cwd();
        try {
          const result = await workspaceGit.pull(project);
          git.invalidate(project);
          services.log("git.pull", result.detail);
          return result;
        } catch (error) {
          git.invalidate(project);
          throw error;
        }
      });
      context.registerCommand("push", async () => {
        const project = cwd();
        try {
          const result = await workspaceGit.push(project);
          git.invalidate(project);
          services.log("git.push", result.detail);
          return result;
        } catch (error) {
          git.invalidate(project);
          throw error;
        }
      }, { callers: [REVIEW_KIT_ID] });
      // Review Kit publishes a repository that has no remote; the remote itself is Git's and set here.
      context.registerCommand("add-remote", async (input) => {
        const project = cwd();
        try {
          const added = await workspaceGit.addFirstRemote(project, optionalString(input, "name") ?? "origin", requiredString(input, "url"));
          services.log("git.remote.added", requiredString(input, "url"));
          return added;
        } finally {
          git.invalidate(project, ["branch", "status", "workspace"]);
        }
      }, { callers: [REVIEW_KIT_ID] });
      // Review Kit opens, merges and edits requests; the Git it needs is read here.
      context.registerCommand("review-request-context", async (input) => {
        // Review's Pull Requests page and its links name another project by id or path.
        const named = optionalString(input, "workspace");
        return readReviewRequestContext(named ? await services.knownWorkspacePath(named) : cwd(), {
          detail: record(input).detail === true,
          ...(optionalString(input, "base") ? { base: optionalString(input, "base") } : {}),
        });
      }, { callers: [REVIEW_KIT_ID] });
      context.registerCommand("workspace-info", async (input) => {
        const canonical = await services.knownWorkspacePath(workspaceOf(input));
        return git.getWorkspaceInfo(canonical);
      });
      context.registerCommand("worktree-statuses", async (input) => {
        const canonical = await services.knownWorkspacePath(workspaceOf(input));
        const sessions = await services.sessions.list();
        return git.getWorktreeStatuses(canonical, sessions.map((session) => session.cwd));
      });
      context.registerCommand("worktree-base", async (input) => {
        const project = await services.knownWorkspacePath(workspaceOf(input));
        const base = await workspaceGit.resolveWorktreeBase(project, {
          ...(optionalString(input, "baseRef") ? { requested: optionalString(input, "baseRef") } : {}),
          ...(record(input).startFromOrigin === undefined ? {} : { startFromOrigin: record(input).startFromOrigin !== false }),
        });
        return { ...base, shortCommit: base.commit.slice(0, 7) };
      }, { long: true });
      context.registerCommand("create-worktree", async (input) => {
        // A pending draft may sit on another project than the host's thread.
        const project = await services.knownWorkspacePath(workspaceOf(input));
        const branch = requiredString(input, "branch");
        const baseRef = optionalString(input, "baseRef");
        const startFromOrigin = record(input).startFromOrigin;
        const requestedSubmodules = record(input).submodules;
        const setupId = await beginSetup(project, branch);
        const step = (stage: string, extra: Record<string, unknown> = {}) => {
          if (setupId) void setupCall("worktree-setup-step", { setupId, stage, ...extra }).catch(() => undefined);
        };
        try {
          const destination = await workspaceGit.createWorktree(project, branch, {
            ...(baseRef ? { baseRef } : {}),
            ...(startFromOrigin === undefined ? {} : { startFromOrigin: startFromOrigin !== false }),
            onStep: (stage) => step(stage),
          }, (path) => git.getWorkspaceInfo(path));
          services.rememberProjectName(destination, await services.projectName(project));
          git.invalidate(project, ["branch", "status", "workspace"]);
          services.log("git.worktree.added", destination);
          await worktrees.storage.remember(destination, project, branch).catch(noteFailure("git.worktree.record-failed"));
          // The setting wins; without one, the project file of the branch just checked out decides.
          const submodules = await initWorktreeSubmodules(destination, isWorktreeSubmodules(requestedSubmodules)
            ? requestedSubmodules
            : (await readProjectDefaults(destination)).worktreeSubmodules, { onStart: () => step("submodules") });
          if (submodules) {
            services.log(submodules.ok ? "git.worktree.submodules" : "git.worktree.submodules-failed", submodules.detail ?? submodules.mode);
            if (!submodules.ok) step("submodules", { failed: true, detail: submodules.detail ?? "git submodule update failed" });
          }
          await runWorktreeSetup(project, destination, setupId);
          // The draft moves here before its thread exists, and asks about it at once.
          return services.admitWorkspace(destination);
        } catch (error) {
          git.invalidate(project, ["branch", "status", "workspace"]);
          if (setupId) await setupCall("worktree-setup-failed", { setupId, error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
          throw error;
        }
      }, { long: true });
      context.registerCommand("worktree-removal-preview", async (input) => {
        const project = await services.knownWorkspacePath(workspaceOf(input));
        const path = requiredString(input, "path");
        const info = await git.getWorkspaceInfo(project);
        const tree = info.worktrees.find((candidate) => candidate.path === path);
        if (!tree) throw new Error(`${path} is not a worktree of this project.`);
        return workspaceGit.previewWorktreeRemoval(project, path, tree.branch);
      });
      context.registerCommand("remove-worktree", async (input) => {
        const project = await services.knownWorkspacePath(workspaceOf(input));
        const path = requiredString(input, "path");
        const info = await git.getWorkspaceInfo(project);
        const tree = info.worktrees.find((candidate) => candidate.path === path);
        if (!tree || tree.isMain) throw new Error("Only a linked worktree can be removed.");
        const sessions = await services.sessions.list();
        const used = sessions.filter((session) => resolve(session.cwd) === resolve(path)).length;
        if (used > 0) throw new Error(`${used} thread${used === 1 ? "" : "s"} still run in this worktree.`);
        const branch = optionalString(input, "branch") ?? tree.branch;
        await workspaceGit.removeWorktree(project, path, branch ? { branch } : {});
        await worktrees.storage.forget(path).catch(noteFailure("git.worktree.record-failed"));
        git.invalidate(project, ["branch", "status", "workspace"]);
        services.log("git.worktree.removed", path);
      }, { long: true });
      context.registerCommand("ensure-worktree", async (input) => {
        const project = await services.knownWorkspacePath(workspaceOf(input));
        const path = requiredString(input, "path");
        const info = await git.getWorkspaceInfo(project);
        const branch = optionalString(input, "branch") ?? info.worktrees.find((tree) => tree.path === path)?.branch;
        const recreated = await workspaceGit.ensureWorktree(project, path, branch);
        if (recreated) {
          await worktrees.storage.restored(path).catch(noteFailure("git.worktree.record-failed"));
          git.invalidate(project, ["branch", "status", "workspace"]);
          services.log("git.worktree.recreated", path);
        }
        return recreated;
      }, { long: true });
      // Read once per project: `origin/HEAD` moves only when someone sets it again.
      const defaultBranches = new Map<string, Promise<string>>();
      context.registerCommand("default-branch", async (input) => {
        const project = await services.knownWorkspacePath(workspaceOf(input));
        let branch = defaultBranches.get(project);
        if (!branch) defaultBranches.set(project, branch = workspaceGit.readDefaultBranch(project));
        return branch;
      });
      // Keeps the default branch current, fast-forward only; the client says when and whether.
      const puller = new DefaultBranchPuller();
      context.registerCommand("auto-pull", async (input) => {
        const project = await services.knownWorkspacePath(workspaceOf(input));
        const info = await git.getWorkspaceInfo(project);
        if (!info.isRepo) return [];
        // A thread in a worktree leaves the default branch in the main checkout.
        const main = info.worktrees.find((tree) => tree.isMain)?.path;
        const checkouts: Array<{ path: string; checkout: "workspace" | "main" }> = [{ path: project, checkout: "workspace" }];
        if (main && resolve(main) !== resolve(project)) checkouts.push({ path: main, checkout: "main" });
        const outcomes = [];
        for (const { path, checkout } of checkouts) {
          const outcome = await puller.run(path);
          if (outcome.status === "pulled") {
            git.invalidate(path);
            if (checkout === "main") git.invalidate(project, ["branch", "workspace"]);
            services.log("git.auto-pull", `${outcome.branch} → ${outcome.head.slice(0, 7)} (${outcome.commits})`);
          }
          outcomes.push({ checkout, ...outcome });
        }
        return outcomes;
      }, { long: true });
      context.registerCommand("project-defaults", async (input) => {
        const project = await services.knownWorkspacePath(workspaceOf(input));
        return readProjectDefaults(project);
      });
      context.registerCommand("switch-ref", async (input) => {
        const project = cwd();
        const ref = requiredString(input, "ref");
        try {
          const target = await workspaceGit.resolveRefTarget(project, ref, (path) => git.getWorkspaceInfo(path));
          services.log("git.ref.switch", `${ref} → ${target}`);
          git.invalidate(project, ["branch", "status", "workspace"]);
          return services.openWorkspace(target);
        } catch (error) {
          git.invalidate(project, ["branch", "status", "workspace"]);
          throw error;
        }
      });
      // Turn checkpoints: capture per runtime, restore, recovery and ref upkeep
      // all live in the kit; core only offers the lifecycle hooks.
      // The rail's `+N −N` per thread outlives the checkpoint announcement in the kit's own state folder.
      const statsPath = services.stateDir ? join(services.stateDir, "turn-stats.json") : undefined;
      const turnStats = createTurnStatsFile({
        read: async () => statsPath ? readFile(statsPath, "utf8").catch(() => undefined) : undefined,
        write: async (text) => {
          if (!statsPath) return;
          await mkdir(dirname(statsPath), { recursive: true });
          await writeFile(statsPath, text);
        },
        schedule: (run) => { setTimeout(run, 2_000).unref?.(); },
      });
      context.registerCommand("turn-stats", () => turnStats.all());
      const checkpoints = createWorkspaceKitLifecycle(services, {
        emit: (event) => {
          if (event.type === "turn-checkpoint") void turnStats.record(event.sessionId, turnStatOf(event.checkpoint));
          context.emit(CHECKPOINT_EVENT, event);
        },
        git,
        branch: (project) => labels.get(project),
      });
      const disposers = [
        services.describeProjects({
          name: (project) => workspaceGit.repositoryDisplayName(project),
          label: async (project) => {
            const branch = await git.getBranch(project);
            labels.set(project, branch);
            return branch;
          },
          nested: (project) => workspaceGit.isNestedProject(project),
        }),
        // Edits and Git commands run by the agent stale the cache.
        services.registerTurnObserver({ toolEnded: (_sessionId, tool, project) => invalidateAfterTool(git, tool, project) }),
        services.registerThreadLifecycle(checkpoints.lifecycle),
        services.registerTurnObserver(checkpoints.turns),
        services.pinTranscriptEntries((thread) => checkpoints.pinnedEntries(thread)),
        services.registerRuntimeExtension("tau-turn-checkpoints", checkpoints.runtimeExtension),
        () => turnStats.flush(),
      ];
      const checkpointRef = (input: unknown) => ({ sessionId: requiredString(input, "sessionId"), checkpointId: requiredString(input, "checkpointId") });
      context.registerCommand("checkpoints", (input) => checkpoints.checkpoints(requiredString(input, "sessionId")));
      context.registerCommand("can-restore", (input) => {
        const { sessionId, checkpointId } = checkpointRef(input);
        return checkpoints.canRestore(sessionId, checkpointId);
      });
      context.registerCommand("restore-preview", (input) => {
        const { sessionId, checkpointId } = checkpointRef(input);
        return checkpoints.restorePreview(sessionId, checkpointId);
      });
      context.registerCommand("restore", (input) => {
        const { sessionId, checkpointId } = checkpointRef(input);
        return checkpoints.restore(sessionId, checkpointId);
      });
      context.registerCommand("rewind", (input) => {
        const { sessionId, checkpointId } = checkpointRef(input);
        return checkpoints.rewind(sessionId, checkpointId);
      });
      context.registerCommand("turn-file-diff", (input) => {
        const { sessionId, checkpointId } = checkpointRef(input);
        return checkpoints.turnFileDiff(sessionId, checkpointId, relativePath(input), record(input).options as DiffLoadOptions | undefined);
      });
      context.registerCommand("turn-files", (input) => {
        const { sessionId, checkpointId } = checkpointRef(input);
        const limit = record(input).limit;
        return checkpoints.turnFiles(sessionId, checkpointId, optionalString(input, "cursor"), typeof limit === "number" ? limit : undefined);
      });
      const installedEditors = () => findInstalledEditors(defaultEditorProbe((name) => services.findCommand(name)));
      const openEditor = async (editorId: string, directory: string, target: string, isFile: boolean, position?: { line?: number; column?: number }) => {
        const editor = installedEditors().find((entry) => entry.id === editorId);
        if (!editor) throw new HostCommandError(`${editorId} is not installed on this machine.`);
        const { command, args } = editorCommand(editor, target, { isFile, platform: process.platform, ...(position ? { position } : {}) });
        services.noteSubprocess();
        await launchEditor(command, args, directory);
      };
      context.registerCommand("list-editors", () => installedEditors().map(({ id, name }) => ({ id, name })));
      context.registerCommand("open-in-editor", async (input) => {
        const project = await services.knownWorkspacePath(workspaceOf(input));
        const editorId = requiredString(input, "editorId");
        const path = optionalRelativePath(input);
        if (path) await workspaceGit.assertWorkspacePath(project, path);
        const target = path ? resolve(project, path) : project;
        const isFile = path ? (await stat(target)).isFile() : false;
        const line = record(input).line;
        const column = record(input).column;
        await openEditor(editorId, project, target, isFile, {
          ...(typeof line === "number" ? { line } : {}),
          ...(typeof column === "number" ? { column } : {}),
        });
      });
      context.registerCommand("list-terminals", () => workspaceGit.listTerminals());
      context.registerCommand("open-terminal", async (input) => {
        const project = await services.knownWorkspacePath(workspaceOf(input));
        const terminalId = optionalString(input, "terminalId");
        await workspaceGit.openTerminal(project, terminalId);
      });
      context.registerCommand("edit-prompt-external", async (input) => {
        const text = optionalString(input, "text") ?? "";
        const editorId = optionalString(input, "editorId");
        const promptFile = join(tmpdir(), `tau-prompt-${Date.now()}.md`);
        await writeFile(promptFile, text, "utf8");
        const available = installedEditors().filter((editor) => editor.id !== FILE_MANAGER_ID);
        const chosen = editorId && available.some((e) => e.id === editorId) ? editorId : available[0]?.id;
        if (!chosen) throw new HostCommandError("No supported editor found on this machine.");
        await openEditor(chosen, dirname(promptFile), promptFile, true);
        return { path: promptFile, editor: chosen };
      });
      context.registerCommand("read-prompt-external", async (input) => {
        const path = requiredString(input, "path");
        try {
          return { text: await readFile(path, "utf8") };
        } catch {
          return { text: undefined };
        }
      });
      disposers.push(() => worktrees.dispose(), () => clones.dispose());
      return () => { for (const dispose of disposers.reverse()) dispose(); };
    },
  };
}

export default createWorkspaceHostExtension;
