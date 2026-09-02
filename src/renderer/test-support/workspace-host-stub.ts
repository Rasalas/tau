import type { WorkspaceHostClient } from "../../shared/workspace-kit-protocol";
import { WORKSPACE_HOST_EXTENSION_ID } from "../../shared/workspace-kit-protocol";

const NO_CHANGES = { files: [], added: 0, removed: 0 };
const NO_REPO = { root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] };

/**
 * Test double for the host side of Workspace Kit. Pass the client methods a test
 * cares about; the result is an `invokeHostExtension` implementation that routes
 * the kit's commands back to those methods with their original argument shapes.
 * Method shapes are loose so a test returns only the fields it needs.
 */
export type WorkspaceHostStubOverrides = {
  [K in keyof WorkspaceHostClient]?: (...args: Parameters<WorkspaceHostClient[K]>) => Promise<unknown>;
};

export function workspaceHostStub(overrides: WorkspaceHostStubOverrides = {}) {
  const unsupported = (name: string) => async () => { throw new Error(`workspaceHostStub: ${name} is not stubbed`); };
  const client: WorkspaceHostStubOverrides & Required<WorkspaceHostStubOverrides> = {
    getFileTree: async () => [],
    getChanges: async () => NO_CHANGES,
    getWorkspaceInfo: async () => NO_REPO,
    listEditors: async () => [],
    getFileDiff: unsupported("getFileDiff"),
    stageFile: unsupported("stageFile"),
    unstageFile: unsupported("unstageFile"),
    stageAll: unsupported("stageAll"),
    revertFile: unsupported("revertFile"),
    readFile: unsupported("readFile"),
    commit: unsupported("commit"),
    push: unsupported("push"),
    createWorktree: unsupported("createWorktree"),
    switchRef: unsupported("switchRef"),
    openInEditor: unsupported("openInEditor"),
    ...overrides,
  };
  const field = <T,>(input: unknown, key: string): T | undefined =>
    input && typeof input === "object" ? (input as Record<string, T>)[key] : undefined;
  const optional = <T,>(value: T | undefined): [] | [T] => value === undefined ? [] : [value];
  return async (extensionId: string, command: string, input?: unknown): Promise<unknown> => {
    // Access Kit pushes its level on activation; tests that render App do not care.
    if (extensionId === "tau.access") return command === "set-level" ? (input as { level?: unknown })?.level : "full";
    if (extensionId !== WORKSPACE_HOST_EXTENSION_ID) throw new Error(`Host extension ${extensionId} is not installed.`);
    switch (command) {
      case "file-tree": return client.getFileTree(...optional(field<string>(input, "path")));
      case "changes": return client.getChanges(...optional(field(input, "query")));
      case "file-diff": return client.getFileDiff(field(input, "path")!, field(input, "options"));
      case "stage-file": return client.stageFile(field(input, "path")!);
      case "unstage-file": return client.unstageFile(field(input, "path")!);
      case "stage-all": return client.stageAll();
      case "revert-file": return client.revertFile(field(input, "path")!);
      case "read-file": return client.readFile(field(input, "path")!);
      case "commit": return client.commit(field(input, "message")!, field(input, "push")!);
      case "push": return client.push();
      case "workspace-info": return client.getWorkspaceInfo(...optional(field<string>(input, "cwd")));
      case "create-worktree": return client.createWorktree(field(input, "branch")!, field(input, "baseRef"));
      case "switch-ref": return client.switchRef(field(input, "ref")!);
      case "list-editors": return client.listEditors();
      case "open-in-editor": return client.openInEditor(field(input, "editorId")!, field(input, "path"));
      default: throw new Error(`Host extension Workspace Kit has no command "${command}".`);
    }
  };
}
