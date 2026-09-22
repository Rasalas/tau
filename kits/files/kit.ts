import type { PreferencesStore, UiEditor, WorkbenchActions } from "tau";
import type { DocumentRegistry } from "./documents.js";
import { FILES_KIT_ID } from "./protocol.js";

/**
 * The part of Workspace Kit's store (`tau.workspace/store`) this kit reads:
 * the followed project, its editors, and the offer to edit files. Copied, not
 * imported — a kit never imports another kit.
 */
export interface WorkspaceStoreLike {
  getSnapshot(): { cwd?: string; editors: UiEditor[] };
  subscribe(listener: () => void): () => void;
  activeEditor(): UiEditor | undefined;
  chooseEditor(id: string): void;
  openInEditor(relPath?: string, editorOverride?: string, position?: { line?: number; column?: number }): Promise<void>;
  refresh(): Promise<void>;
  registerFileEditor?(editor: (relPath: string, actions: WorkbenchActions) => void): () => void;
}

/** What the kit holds while it is active; the tabs read it, the activation fills and clears it. */
export interface FilesKit {
  documents: DocumentRegistry;
  preferences: PreferencesStore;
  workspace?: WorkspaceStoreLike;
  /** Workspace Kit's store answers subscribers when it arrives or goes. */
  listeners: Set<() => void>;
}

export const kit: { current?: FilesKit } = {};

export const AUTOSAVE_OPTION = "autosave";
export const AUTOSAVE_DELAY_MS = 1_000;

export function autosaveDelay(preferences: PreferencesStore): number | undefined {
  return preferences.optionValue(FILES_KIT_ID, AUTOSAVE_OPTION, false) ? AUTOSAVE_DELAY_MS : undefined;
}

/** A path inside the workspace, from an absolute one when it lies under `root`. */
export function workspaceRelative(path: string, root: string | undefined): string | undefined {
  if (!path.startsWith("/") && !/^[a-z]:[\\/]/iu.test(path)) return path.replace(/\\/gu, "/");
  if (!root) return undefined;
  const base = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(base) ? path.slice(base.length) : undefined;
}
