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

export interface FilesHostCommands {
  read: { input: { relPath: string }; output: UiFileContent };
  stat: { input: { relPath: string }; output: UiFileStat };
  write: { input: { relPath: string; text: string; expectedMtimeMs?: number | null }; output: UiFileWriteResult };
}

export interface FilesHost {
  read(relPath: string): Promise<UiFileContent>;
  stat(relPath: string): Promise<UiFileStat>;
  write(relPath: string, text: string, expectedMtimeMs?: number | null): Promise<UiFileWriteResult>;
}

export function createFilesHost(invoke: (command: string, input?: unknown) => Promise<unknown>): FilesHost {
  const call = <K extends keyof FilesHostCommands>(command: K, input: FilesHostCommands[K]["input"]) =>
    invoke(command, input) as Promise<FilesHostCommands[K]["output"]>;
  return {
    read: (relPath) => call("read", { relPath }),
    stat: (relPath) => call("stat", { relPath }),
    write: (relPath, text, expectedMtimeMs) => call("write", expectedMtimeMs === undefined ? { relPath, text } : { relPath, text, expectedMtimeMs }),
  };
}
