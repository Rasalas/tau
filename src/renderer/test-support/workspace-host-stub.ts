const WORKSPACE_HOST_EXTENSION_ID = "tau.workspace";

/**
 * The Workspace Kit command names this double answers. The kit owns the real
 * contract (`kits/workspace/protocol.ts`); core keeps its own list so a test
 * that renders `App` never has to reach into a kit.
 */
interface WorkspaceHostClient {
  listDirectories(path?: string): Promise<unknown>;
  pickFolder(): Promise<unknown>;
  startClone(repositoryUrl: string, parentPath?: string): Promise<unknown>;
  cancelClone(id: string): Promise<unknown>;
  listClones(): Promise<unknown>;
  forgetClone(id: string): Promise<unknown>;
  getFileTree(relPath?: string, workspace?: string): Promise<unknown>;
  getChanges(query?: unknown): Promise<unknown>;
  getFileDiff(relPath: string, options?: unknown, workspace?: string): Promise<unknown>;
  stageFile(relPath: string): Promise<unknown>;
  unstageFile(relPath: string): Promise<unknown>;
  stageAll(): Promise<unknown>;
  revertFile(relPath: string): Promise<unknown>;
  readFile(relPath: string, workspace?: string): Promise<unknown>;
  commit(message: string, push: boolean): Promise<unknown>;
  pull(): Promise<unknown>;
  push(): Promise<unknown>;
  getWorkspaceInfo(workspace?: string): Promise<unknown>;
  getWorktreeStatuses(workspace?: string): Promise<unknown>;
  getWorktreeBase(workspace?: string, options?: unknown): Promise<unknown>;
  createWorktree(branch: string, options?: unknown, workspace?: string): Promise<unknown>;
  getWorktreeRemoval(path: string, workspace?: string): Promise<unknown>;
  removeWorktree(path: string, branch?: string, workspace?: string): Promise<unknown>;
  ensureWorktree(path: string, branch?: string, workspace?: string): Promise<unknown>;
  getProjectDefaults(workspace?: string): Promise<unknown>;
  getDefaultBranch(workspace?: string): Promise<unknown>;
  autoPull(workspace?: string): Promise<unknown>;
  switchRef(ref: string): Promise<unknown>;
  listEditors(): Promise<unknown>;
  openInEditor(editorId: string, relPath?: string, workspace?: string): Promise<unknown>;
  checkpoints(sessionId: string): Promise<unknown>;
  canRestoreCheckpoint(sessionId: string, checkpointId: string): Promise<unknown>;
  getRestorePreview(sessionId: string, checkpointId: string): Promise<unknown>;
  restoreCheckpoint(sessionId: string, checkpointId: string): Promise<unknown>;
  rewindCheckpoint(sessionId: string, checkpointId: string): Promise<unknown>;
  getTurnFileDiff(sessionId: string, checkpointId: string, relPath: string, options?: unknown): Promise<unknown>;
  getTurnFiles(sessionId: string, checkpointId: string, cursor?: string, limit?: number): Promise<unknown>;
}

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

export type HostExtensionStub = (command: string, input?: unknown) => Promise<unknown>;

export function workspaceHostStub(overrides: WorkspaceHostStubOverrides = {}, extensions: Record<string, HostExtensionStub> = {}) {
  const unsupported = (name: string) => async () => { throw new Error(`workspaceHostStub: ${name} is not stubbed`); };
  const client: WorkspaceHostStubOverrides & Required<WorkspaceHostStubOverrides> = {
    listDirectories: unsupported("listDirectories"),
    pickFolder: unsupported("pickFolder"),
    startClone: unsupported("startClone"),
    cancelClone: async () => false,
    listClones: async () => [],
    forgetClone: async () => undefined,
    getFileTree: async () => [],
    getChanges: async () => NO_CHANGES,
    getWorkspaceInfo: async () => NO_REPO,
    getWorktreeStatuses: async () => [],
    listEditors: async () => [],
    getFileDiff: unsupported("getFileDiff"),
    stageFile: unsupported("stageFile"),
    unstageFile: unsupported("unstageFile"),
    stageAll: unsupported("stageAll"),
    revertFile: unsupported("revertFile"),
    readFile: unsupported("readFile"),
    commit: unsupported("commit"),
    pull: unsupported("pull"),
    push: unsupported("push"),
    getWorktreeBase: async () => ({ ref: "origin/main", commit: "0".repeat(40), shortCommit: "0000000", fromOrigin: true }),
    createWorktree: unsupported("createWorktree"),
    getWorktreeRemoval: async () => ({ path: "", dirtyFiles: 0, ahead: 0 }),
    removeWorktree: unsupported("removeWorktree"),
    ensureWorktree: async () => false,
    getProjectDefaults: async () => ({}),
    getDefaultBranch: async () => "main",
    autoPull: async () => [],
    switchRef: unsupported("switchRef"),
    openInEditor: unsupported("openInEditor"),
    checkpoints: async () => ({ checkpoints: [], restoreSupported: false }),
    canRestoreCheckpoint: async () => false,
    getRestorePreview: unsupported("getRestorePreview"),
    restoreCheckpoint: unsupported("restoreCheckpoint"),
    rewindCheckpoint: unsupported("rewindCheckpoint"),
    getTurnFileDiff: unsupported("getTurnFileDiff"),
    getTurnFiles: unsupported("getTurnFiles"),
    ...overrides,
  };
  const field = <T,>(input: unknown, key: string): T | undefined =>
    input && typeof input === "object" ? (input as Record<string, T>)[key] : undefined;
  const optional = <T,>(value: T | undefined): [] | [T] => value === undefined ? [] : [value];
  /** The worktree options travel beside the command's own fields. */
  const worktreeOptions = (input: unknown) => ({
    ...(field<string>(input, "baseRef") === undefined ? {} : { baseRef: field<string>(input, "baseRef") }),
    ...(field<boolean>(input, "startFromOrigin") === undefined ? {} : { startFromOrigin: field<boolean>(input, "startFromOrigin") }),
    ...(field<string>(input, "submodules") === undefined ? {} : { submodules: field<string>(input, "submodules") }),
  });
  return async (extensionId: string, command: string, input?: unknown): Promise<unknown> => {
    // Access Kit pushes its level on activation; tests that render App do not care.
    if (extensionId in extensions) return extensions[extensionId]!(command, input);
    if (extensionId === "tau.access") return command === "set-level" ? (input as { level?: unknown })?.level : "full";
    // Keybindings asks for Pi keybindings and shortcuts on activation; tests have none.
    if (extensionId === "tau.keybindings") return command === "pi-keybindings" ? { bindings: {} } : command === "shortcuts" ? { shortcuts: [] } : undefined;
    if (extensionId === "tau.pi-ui") return undefined;
    if (extensionId !== WORKSPACE_HOST_EXTENSION_ID) throw new Error(`Host extension ${extensionId} is not installed.`);
    switch (command) {
      case "list-directories": return client.listDirectories(...optional(field<string>(input, "path")));
      case "pick-folder": return client.pickFolder();
      case "clone-start": return client.startClone(field(input, "repositoryUrl")!, ...optional(field<string>(input, "parentPath")));
      case "clone-cancel": return client.cancelClone(field(input, "id")!);
      case "clone-jobs": return client.listClones();
      case "clone-forget": return client.forgetClone(field(input, "id")!);
      case "file-tree": return field<string>(input, "workspace") === undefined
        ? client.getFileTree(...optional(field<string>(input, "relPath")))
        : client.getFileTree(field<string>(input, "relPath"), field<string>(input, "workspace"));
      case "changes": return client.getChanges(...optional(field(input, "query")));
      case "file-diff": return client.getFileDiff(field(input, "relPath")!, field(input, "options"), ...optional(field<string>(input, "workspace")));
      case "stage-file": return client.stageFile(field(input, "relPath")!);
      case "unstage-file": return client.unstageFile(field(input, "relPath")!);
      case "stage-all": return client.stageAll();
      case "revert-file": return client.revertFile(field(input, "relPath")!);
      case "read-file": return client.readFile(field(input, "relPath")!, ...optional(field<string>(input, "workspace")));
      case "commit": return client.commit(field(input, "message")!, field(input, "push")!);
      case "pull": return client.pull();
      case "push": return client.push();
      case "workspace-info": return client.getWorkspaceInfo(...optional(field<string>(input, "workspace")));
      case "worktree-statuses": return client.getWorktreeStatuses(...optional(field<string>(input, "workspace")));
      case "worktree-base": return client.getWorktreeBase(field(input, "workspace"), worktreeOptions(input));
      case "create-worktree": return client.createWorktree(field(input, "branch")!, worktreeOptions(input), field(input, "workspace"));
      case "worktree-removal-preview": return client.getWorktreeRemoval(field(input, "path")!, field(input, "workspace"));
      case "remove-worktree": return client.removeWorktree(field(input, "path")!, field(input, "branch"), field(input, "workspace"));
      case "ensure-worktree": return client.ensureWorktree(field(input, "path")!, field(input, "branch"), field(input, "workspace"));
      case "project-defaults": return client.getProjectDefaults(field(input, "workspace"));
      case "default-branch": return client.getDefaultBranch(...optional(field<string>(input, "workspace")));
      case "auto-pull": return client.autoPull(...optional(field<string>(input, "workspace")));
      case "switch-ref": return client.switchRef(field(input, "ref")!);
      case "list-editors": return client.listEditors();
      case "open-in-editor": return client.openInEditor(field(input, "editorId")!, field(input, "relPath"), field(input, "workspace"));
      case "checkpoints": return client.checkpoints(field(input, "sessionId")!);
      case "can-restore": return client.canRestoreCheckpoint(field(input, "sessionId")!, field(input, "checkpointId")!);
      case "restore-preview": return client.getRestorePreview(field(input, "sessionId")!, field(input, "checkpointId")!);
      case "restore": return client.restoreCheckpoint(field(input, "sessionId")!, field(input, "checkpointId")!);
      case "rewind": return client.rewindCheckpoint(field(input, "sessionId")!, field(input, "checkpointId")!);
      case "turn-file-diff": return client.getTurnFileDiff(field(input, "sessionId")!, field(input, "checkpointId")!, field(input, "relPath")!, field(input, "options"));
      case "turn-files": return client.getTurnFiles(field(input, "sessionId")!, field(input, "checkpointId")!, field(input, "cursor"), field(input, "limit"));
      default: throw new Error(`Host extension Workspace Kit has no command "${command}".`);
    }
  };
}
