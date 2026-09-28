// Type-only imports: both halves read this file, and so may another kit.
import type { UiFileContent, UiFileStat, UiFileWriteResult } from "tau";

export const FILES_KIT_ID = "tau.files";
/** The stage tab kind that edits one workspace file, or shows it when it is a PDF or media. */
export const FILE_EDITOR_TAB = "tau.files.editor";
/** Workspace Kit owns reading and writing files; this kit's host proxies to it. */
export const WORKSPACE_KIT_ID = "tau.workspace";
export const WORKSPACE_STORE_SERVICE = "tau.workspace/store";

/** What an editor tab is opened and restored with. */
export interface FileEditorParams extends Record<string, unknown> {
  /** The file's path inside the workspace, POSIX separators. */
  path: string;
  /** 1-based line to reveal when the tab opens. */
  line?: number;
}

/** Why a file whose project nobody named is neither read nor written. */
export const UNKNOWN_PROJECT = "Tau does not know which project this file belongs to.";

/** Every command names the project the file belongs to; none falls back to the one the host has open. */
export interface FilesHostCommands {
  read: { input: { workspace: string; relPath: string }; output: UiFileContent };
  stat: { input: { workspace: string; relPath: string }; output: UiFileStat };
  write: { input: { workspace: string; relPath: string; text: string; expectedMtimeMs?: number | null }; output: UiFileWriteResult };
}

/** `workspace` is the project's id where the host mints one, its path otherwise. */
export interface FilesHost {
  read(workspace: string, relPath: string): Promise<UiFileContent>;
  stat(workspace: string, relPath: string): Promise<UiFileStat>;
  write(workspace: string, relPath: string, text: string, expectedMtimeMs?: number | null): Promise<UiFileWriteResult>;
}

export function createFilesHost(invoke: (command: string, input?: unknown) => Promise<unknown>): FilesHost {
  const call = <K extends keyof FilesHostCommands>(command: K, input: FilesHostCommands[K]["input"]) =>
    invoke(command, input) as Promise<FilesHostCommands[K]["output"]>;
  return {
    read: (workspace, relPath) => call("read", { workspace, relPath }),
    stat: (workspace, relPath) => call("stat", { workspace, relPath }),
    write: (workspace, relPath, text, expectedMtimeMs) => call("write", expectedMtimeMs === undefined
      ? { workspace, relPath, text }
      : { workspace, relPath, text, expectedMtimeMs }),
  };
}
