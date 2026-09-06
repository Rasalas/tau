import type { DiffLoadOptions, HostExtensionClient, UiFileDiff, UiWorkspaceChanges, WorkspaceChangesQuery } from "tau";
import type { WorkspaceHostCommand } from "../workspace/protocol.js";

/**
 * The slice of Workspace Kit's host entry that Review asks: the changes and
 * one file's diff. Everything else Review needs about the workspace comes
 * from the store that kit publishes as a service.
 */
export interface WorkspaceChangesReader {
  changes(query?: WorkspaceChangesQuery): Promise<UiWorkspaceChanges>;
  fileDiff(relPath: string, options?: DiffLoadOptions): Promise<UiFileDiff>;
}

const CHANGES: WorkspaceHostCommand = "changes";
const FILE_DIFF: WorkspaceHostCommand = "file-diff";

export function workspaceChangesReader(host: HostExtensionClient): WorkspaceChangesReader {
  return {
    changes: (query) => host.invoke(CHANGES, query === undefined ? undefined : { query }) as Promise<UiWorkspaceChanges>,
    fileDiff: (relPath, options) => host.invoke(FILE_DIFF, { relPath, options }) as Promise<UiFileDiff>,
  };
}
