import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { DiffLoadOptions, FileNode, WorkspaceChangesQuery } from "../../shared/contracts.js";
import { WORKSPACE_HOST_EXTENSION_ID } from "../../shared/workspace-kit-protocol.js";
import { readBoundedFileContent } from "../file-content.js";
import type { HostExtension, HostExtensionContext } from "../host-extensions.js";
import * as workspaceGit from "../workspace-git.js";

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "dist-electron", ".next"]);
const VISIBLE_DOT_DIRECTORIES = new Set([".pi", ".scratch"]);
const MAX_TREE_DEPTH = 4;
const MAX_TREE_ENTRIES = 320;

export async function readFileTree(path: string, depth = 0, budget = { count: 0 }): Promise<FileNode[]> {
  if (depth > MAX_TREE_DEPTH || budget.count > MAX_TREE_ENTRIES) return [];
  const entries = await readdir(path, { withFileTypes: true });
  const nodes: FileNode[] = [];
  for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
    if (budget.count++ > MAX_TREE_ENTRIES) break;
    if (entry.name.startsWith(".") && !VISIBLE_DOT_DIRECTORIES.has(entry.name)) continue;
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    nodes.push({ name: entry.name, path: join(path, entry.name), kind: entry.isDirectory() ? "directory" : "file" });
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
 * Workspace Kit's host entry: files, Git status and staging, commits, worktrees
 * and external editors. Everything here used to be a method on PiHost.
 */
export function createWorkspaceHostExtension(): HostExtension {
  return {
    id: WORKSPACE_HOST_EXTENSION_ID,
    name: "Workspace Kit",
    activate(context: HostExtensionContext) {
      const { services } = context;
      const git = services.git;
      const cwd = () => services.cwd();
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

      context.registerCommand("file-tree", async (input) => {
        const project = cwd();
        const root = optionalString(input, "path") ?? project;
        await workspaceGit.assertWorkspacePath(project, root);
        return readFileTree(root);
      });
      context.registerCommand("changes", async (input) => {
        const query = (record(input).query ?? {}) as WorkspaceChangesQuery;
        if (query.scope === "branch") return workspaceGit.getBranchChanges(cwd(), query);
        return git.getChanges(cwd());
      });
      context.registerCommand("file-diff", async (input) => {
        const project = cwd();
        const path = requiredString(input, "path");
        await workspaceGit.assertWorkspacePath(project, path);
        return workspaceGit.getFileDiff(project, path, record(input).options as DiffLoadOptions | undefined);
      });
      context.registerCommand("stage-file", (input) => stageThen(requiredString(input, "path"), workspaceGit.stageFile));
      context.registerCommand("unstage-file", (input) => stageThen(requiredString(input, "path"), workspaceGit.unstageFile));
      context.registerCommand("revert-file", (input) => stageThen(requiredString(input, "path"), workspaceGit.revertFile));
      context.registerCommand("stage-all", async () => {
        const project = cwd();
        await workspaceGit.stageAll(project);
        return refreshedChanges(project);
      });
      context.registerCommand("read-file", async (input) => {
        const project = cwd();
        const path = requiredString(input, "path");
        await workspaceGit.assertWorkspacePath(project, path);
        return readBoundedFileContent(resolve(project, path));
      });
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
      });
      context.registerCommand("workspace-info", async (input) => {
        const canonical = await services.knownWorkspacePath(optionalString(input, "cwd") ?? cwd());
        return git.getWorkspaceInfo(canonical);
      });
      context.registerCommand("create-worktree", async (input) => {
        const project = cwd();
        const branch = requiredString(input, "branch");
        const baseRef = optionalString(input, "baseRef");
        try {
          const destination = await workspaceGit.createWorktree(project, branch, baseRef, (path) => git.getWorkspaceInfo(path));
          services.rememberProjectName(destination, await services.projectName(project));
          git.invalidate(project, ["branch", "status", "workspace"]);
          services.log("git.worktree.added", destination);
          return services.openWorkspace(destination);
        } catch (error) {
          git.invalidate(project, ["branch", "status", "workspace"]);
          throw error;
        }
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
      context.registerCommand("list-editors", () => workspaceGit.listEditors());
      context.registerCommand("open-in-editor", async (input) => {
        const project = cwd();
        const editorId = requiredString(input, "editorId");
        const path = optionalString(input, "path");
        if (path) await workspaceGit.assertWorkspacePath(project, path);
        await workspaceGit.openInEditor(project, editorId, path);
      });
    },
  };
}
