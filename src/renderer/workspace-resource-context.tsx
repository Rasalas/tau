import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import type { UiFileContent } from "../shared/workspace-kit-types";
import type { WorkspaceResourceOrigin } from "../workbench/stage";
import type { DocumentSourceContribution } from "./extension-system";
import { useHostClient } from "./host-client-context";
import { WorkbenchContext } from "./workbench-context";

export type { WorkspaceResourceOrigin } from "../workbench/stage";

/** Renderer-only authority bound to the transcript, never the active project. */
export interface WorkspaceResources {
  readonly origin?: WorkspaceResourceOrigin;
  readonly available: boolean;
  loadFile(relativePath: string): Promise<UiFileContent>;
  openFile(relativePath: string): void;
}

export const RESOURCE_UNAVAILABLE = "This thread's workspace files are unavailable on this connection.";
const Context = createContext<WorkspaceResources | undefined>(undefined);

export function useWorkspaceResources(): WorkspaceResources | undefined {
  return useContext(Context);
}

/** Do not resolve a device/absolute path or silently normalize traversal away. */
export function resourceRelativePath(path: string): string {
  const relative = path.replace(/^\.\//u, "");
  if (!relative || relative.startsWith("/") || relative.includes("\\") || /^[A-Za-z]:/u.test(relative) || relative.split("/").some((part) => part === ".." || part === "")) {
    throw new Error("Name a file by its path inside the thread's workspace.");
  }
  return relative;
}

/** Legacy tool links may name host paths, but only under this transcript's announced root. */
export function transcriptFilePath(path: string, displayPath: string | undefined): string {
  const posix = path.replace(/\\/gu, "/");
  if (!posix.startsWith("/") && !/^[A-Za-z]:\//u.test(posix)) return resourceRelativePath(path);
  const root = displayPath?.replace(/\\/gu, "/").replace(/\/+$/u, "");
  if (!root || !posix.startsWith(`${root}/`)) throw new Error(RESOURCE_UNAVAILABLE);
  return resourceRelativePath(posix.slice(root.length + 1));
}

/** Captures the registered source and explicit origin before any asynchronous read. */
export function bindWorkspaceFileLoader(source: DocumentSourceContribution | undefined, origin: WorkspaceResourceOrigin | null | undefined): (path: string) => Promise<UiFileContent> {
  const workspace = origin?.workspace;
  const sourceId = origin?.sourceId;
  return async (path) => {
    const relative = resourceRelativePath(path);
    if (!source || !workspace || source.id !== sourceId) throw new Error(RESOURCE_UNAVAILABLE);
    try { return await source.loadFile(relative, { workspace }); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/ENOENT|not a known Tau project/iu.test(message)) throw new Error(`File not found in this thread's workspace. ${message}`, { cause: error });
      if (/forbidden|denied|EACCES|permission/iu.test(message)) throw new Error("Access to this workspace file was denied.", { cause: error });
      if (/offline|disconnect|not connected|not reachable/iu.test(message)) throw new Error("The file's host is offline. Reconnect and open the file again.", { cause: error });
      if (/unsupported|not supported|Update .*machine/iu.test(message)) throw new Error("This host does not support reading this file. Update the host and try again.", { cause: error });
      throw error;
    }
  };
}

/** Also adapts existing file chips, which still call WorkbenchContext.openFile. */
export function WorkspaceResourceProvider({ sessionId, workspace, displayPath, children }: { sessionId?: string; workspace?: string; displayPath?: string; children: ReactNode }) {
  const workbench = useContext(WorkbenchContext);
  const client = useHostClient();
  const source = workbench?.registry.getDocumentSource();
  const resources = useMemo(() => {
    const origin: WorkspaceResourceOrigin | undefined = sessionId && workspace && source ? Object.freeze({ sessionId, workspace, sourceId: source.id }) : undefined;
    const lease = { active: true };
    const load = bindWorkspaceFileLoader(source, origin);
    const value: WorkspaceResources = {
      origin, available: Boolean(origin),
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
    };
    return { value, lease };
  }, [client, sessionId, source, workspace, workbench?.openWorkspaceFile]);
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
