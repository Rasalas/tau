import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import type { UiEditor, UiFileContent } from "../shared/workspace-kit-types";
import { linkedFileLocation, linkedFilePath } from "../shared/linked-file-path";
import type { WorkspaceResourceOrigin } from "../workbench/stage";
import type { DocumentSourceContribution } from "./extension-system";
import { useHostClient } from "./host-client-context";
import { WorkbenchContext } from "./workbench-context";

export type { WorkspaceResourceOrigin } from "../workbench/stage";

/** Renderer-only authority bound to the transcript, never the active project. */
export interface WorkspaceResources {
  readonly origin?: WorkspaceResourceOrigin;
  readonly available: boolean;
  readonly displayPath?: string;
  /** False when files live on another machine than the connected host. */
  readonly local?: boolean;
  loadFile(relativePath: string): Promise<UiFileContent>;
  loadMedia?(path: string): Promise<{ url: string; mimeType: string; release?: () => void; mainCheckoutPath?: string; resolvedPath?: string }>;
  loadVisualization?(relativePath: string, theme: "light" | "dark"): Promise<{ url: string; release?: () => void }>;
  openFile(relativePath: string): void;
  /** Where the host machine can show this thread's files; absent when it cannot (a phone, another machine's thread). */
  hostFiles?(): { editor?: UiEditor; fileManager?: UiEditor; open(relativePath: string, editorId: string): void } | undefined;
}

export const RESOURCE_UNAVAILABLE = "This thread's workspace files are unavailable on this connection.";
const Context = createContext<WorkspaceResources | undefined>(undefined);

export function useWorkspaceResources(): WorkspaceResources | undefined {
  return useContext(Context);
}

/** Resources for a document that belongs to no thread, such as a Markdown file in a file tab. */
export function WorkspaceResourcesScope({ value, children }: { value: WorkspaceResources; children: ReactNode }) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Do not resolve a device/absolute path or silently normalize traversal away. */
export function resourceRelativePath(path: string): string {
  const relative = path.replace(/^\.\//u, "");
  if (!relative || relative.startsWith("/") || relative.includes("\\") || /^[A-Za-z]:/u.test(relative) || relative.split("/").some((part) => part === ".." || part === "")) {
    throw new Error("Name a file by its path inside the thread's workspace.");
  }
  return relative;
}

/** Keep external links as host paths; in-workspace links keep their relative tab names. */
export function transcriptFilePath(path: string, displayPath: string | undefined): string {
  const location = linkedFileLocation(path);
  const posix = linkedFilePath(location.path) + (location.line ? `:${location.line}` : "");
  if (!posix.startsWith("/") && !/^[A-Za-z]:\//u.test(posix)) return posix;
  const root = displayPath?.replace(/\\/gu, "/").replace(/\/+$/u, "");
  return root && posix.startsWith(`${root}/`) ? posix.slice(root.length + 1) : posix;
}

/** Captures the registered source and explicit origin before any asynchronous read. */
export function bindWorkspaceFileLoader(source: DocumentSourceContribution | undefined, origin: WorkspaceResourceOrigin | null | undefined): (path: string) => Promise<UiFileContent> {
  const workspace = origin?.workspace;
  const sourceId = origin?.sourceId;
  return async (path) => {
    if (!source || !workspace || source.id !== sourceId) throw new Error(RESOURCE_UNAVAILABLE);
    const filePath = linkedFilePath(path);
    try {
      return source.loadLinkedFile
        ? await source.loadLinkedFile(filePath, { workspace })
        : await source.loadFile(resourceRelativePath(path), { workspace });
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/ENOENT|not a known Tau project/iu.test(message)) throw new Error(`File not found on this thread's machine. ${message}`, { cause: error });
      if (/forbidden|denied|EACCES|permission/iu.test(message)) throw new Error("Access to this workspace file was denied.", { cause: error });
      if (/offline|disconnect|not connected|not reachable/iu.test(message)) throw new Error("The file's machine is offline. Reconnect and open the file again.", { cause: error });
      if (/unsupported|not supported|Update .*machine/iu.test(message)) throw new Error("This machine does not support reading this file. Update Tau on it and try again.", { cause: error });
      throw error;
    }
  };
}

/** Also adapts existing file chips, which still call WorkbenchContext.openFile. */
export function WorkspaceResourceProvider({ sessionId, workspace, displayPath, local = true, children }: { sessionId?: string; workspace?: string; displayPath?: string; /** False when the files are on another machine than the window's host. */ local?: boolean; children: ReactNode }) {
  const workbench = useContext(WorkbenchContext);
  const client = useHostClient();
  const source = workbench?.registry.getDocumentSource();
  const resources = useMemo(() => {
    const origin: WorkspaceResourceOrigin | undefined = sessionId && workspace && source ? Object.freeze({ sessionId, workspace, sourceId: source.id }) : undefined;
    const lease = { active: true };
    const load = bindWorkspaceFileLoader(source, origin);
    const value: WorkspaceResources = {
      origin, available: Boolean(origin), displayPath, local,
      loadMedia: source?.loadMedia ? async (path) => {
        if (!lease.active || !origin || !source?.loadMedia) throw new Error("This machine does not support media previews.");
        const result = await source.loadMedia(linkedFilePath(path), { workspace: origin.workspace });
        if (!lease.active) { result.release?.(); throw new Error(RESOURCE_UNAVAILABLE); }
        return result;
      } : undefined,
      loadVisualization: async (path, theme) => {
        if (!lease.active || !origin || !source?.loadVisualization) throw new Error("This machine does not support inline visualizations.");
        const result = await source.loadVisualization(resourceRelativePath(path), { workspace: origin.workspace }, theme);
        if (!lease.active) { result.release?.(); throw new Error(RESOURCE_UNAVAILABLE); }
        return result;
      },
      loadFile: async (path) => {
        if (!lease.active) throw new Error(RESOURCE_UNAVAILABLE);
        const file = await load(path);
        if (!lease.active) throw new Error(RESOURCE_UNAVAILABLE);
        return file;
      },
      openFile: (path) => {
        if (!lease.active) return;
        // Path validation happens in the reader too, so an invalid link gets readable guidance.
        workbench?.openWorkspaceFile?.(path.replace(/^\.\//u, ""), origin ?? null);
      },
      hostFiles: () => {
        if (!lease.active || !local || !origin || !source) return undefined;
        const state = source.getState();
        // With no other editor installed, the source's default editor is the file manager itself.
        const editor = state.editor && state.editor.id !== state.fileManager?.id ? state.editor : undefined;
        if (!editor && !state.fileManager) return undefined;
        return { editor, fileManager: state.fileManager, open: (path, editorId) => source.openInEditor(path, { workspace: origin.workspace, editorId }) };
      },
    };
    return { value, lease };
  }, [client, displayPath, local, sessionId, source, workspace, workbench?.openWorkspaceFile]);
  useEffect(() => {
    resources.lease.active = true;
    return () => { resources.lease.active = false; };
  }, [resources]);
  const context = useMemo(() => workbench ? { ...workbench, openFile: (path: string) => {
    try { resources.value.openFile(transcriptFilePath(path, displayPath)); }
    catch { if (resources.lease.active) workbench.openWorkspaceFile?.(path, null); }
  } } : undefined, [resources, workbench, displayPath]);
  return <Context.Provider value={resources.value}><WorkbenchContext.Provider value={context}>{children}</WorkbenchContext.Provider></Context.Provider>;
}
