import type { DiffLoadOptions, HostExtensionClient, UiFileDiff, UiWorkspaceChanges, WorkspaceChangesQuery } from "tau";

/**
 * The slice of Workspace Kit's host entry that Review asks: the changes and
 * one file's diff. Everything else Review needs about the workspace comes
 * from the store that kit publishes as a service.
 */
export interface WorkspaceChangesReader {
  changes(query?: WorkspaceChangesQuery): Promise<UiWorkspaceChanges>;
  fileDiff(relPath: string, options?: DiffLoadOptions): Promise<UiFileDiff>;
}

const CHANGES = "changes";
const FILE_DIFF = "file-diff";

export function workspaceChangesReader(host: HostExtensionClient, workspace: () => string | undefined = () => undefined): WorkspaceChangesReader {
  return {
    changes: (query) => {
      const named = workspace();
      return host.invoke(CHANGES, query === undefined && named === undefined ? undefined : { ...(query === undefined ? {} : { query }), ...(named ? { workspace: named } : {}) }) as Promise<UiWorkspaceChanges>;
    },
    fileDiff: (relPath, options) => {
      const named = workspace();
      return host.invoke(FILE_DIFF, { relPath, options, ...(named ? { workspace: named } : {}) }) as Promise<UiFileDiff>;
    },
  };
}
