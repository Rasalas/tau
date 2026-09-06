import type { DiffLoadOptions, HostExtensionClient, UiFileDiff, UiWorkspaceChanges, WorkspaceChangesQuery } from "tau";
import { WORKSPACE_CHANGES_COMMAND, WORKSPACE_FILE_DIFF_COMMAND } from "./protocol.js";

/**
 * The slice of Workspace Kit that Review reads. Everything else Review needs
 * about the workspace comes from the store the two kits share, so this stays
 * two commands wide.
 */
export interface WorkspaceChangesReader {
  changes(query?: WorkspaceChangesQuery): Promise<UiWorkspaceChanges>;
  fileDiff(relPath: string, options?: DiffLoadOptions): Promise<UiFileDiff>;
}

export function workspaceChangesReader(host: HostExtensionClient): WorkspaceChangesReader {
  return {
    changes: (query) => host.invoke(WORKSPACE_CHANGES_COMMAND, query === undefined ? undefined : { query }) as Promise<UiWorkspaceChanges>,
    fileDiff: (relPath, options) => host.invoke(WORKSPACE_FILE_DIFF_COMMAND, { relPath, options }) as Promise<UiFileDiff>,
  };
}
