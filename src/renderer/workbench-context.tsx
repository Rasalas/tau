import { createContext, useContext } from "react";
import type { FileNode, HostEvent, HostSnapshot, UiToolRun, UiWorkspaceChanges } from "../shared/contracts";
import type { ExtensionRegistry } from "./extension-system";
import type { ThreadStore } from "./thread-store";

export interface TimelineEvent {
  id: string;
  label: string;
  detail?: string;
  timestamp: number;
}

export interface WorkbenchContextValue {
  snapshot?: HostSnapshot;
  tools: UiToolRun[];
  events: TimelineEvent[];
  fileTree: FileNode[];
  changes: UiWorkspaceChanges;
  registry: ExtensionRegistry;
  refreshFiles(): Promise<void>;
  loadFiles(path: string): Promise<FileNode[]>;
  refreshChanges(): Promise<void>;
  openReview(path?: string): void;
  applySnapshot(snapshot: HostSnapshot): void;
  handleHostEvent(event: HostEvent): void;
}

export interface WorkbenchShellContextValue {
  snapshot?: HostSnapshot;
  registry: ExtensionRegistry;
}

/** Narrow contexts keep panel updates local to the data they display. */
export interface PanelProjectSnapshot { cwd: string }

export interface FilesContextValue {
  fileTree: FileNode[];
  snapshot?: PanelProjectSnapshot;
  refreshFiles(): Promise<void>;
  loadFiles(path: string): Promise<FileNode[]>;
}

export interface ChangesContextValue {
  changes: UiWorkspaceChanges;
  snapshot?: PanelProjectSnapshot;
  refreshChanges(): Promise<void>;
  openReview(path?: string): void;
}

export interface ObservatoryContextValue {
  events: TimelineEvent[];
  snapshot?: HostSnapshot;
  tools: UiToolRun[];
  registry: ExtensionRegistry;
}

export const WorkbenchContext = createContext<WorkbenchContextValue | undefined>(undefined);
export const FilesContext = createContext<FilesContextValue | undefined>(undefined);
export const ChangesContext = createContext<ChangesContextValue | undefined>(undefined);
export const ObservatoryContext = createContext<ObservatoryContextValue | undefined>(undefined);
export const WorkbenchShellContext = createContext<WorkbenchShellContextValue | undefined>(undefined);
export const ThreadStoreContext = createContext<ThreadStore | undefined>(undefined);

export function useWorkbench(): WorkbenchContextValue {
  const value = useContext(WorkbenchContext);
  if (!value) throw new Error("WorkbenchContext is not available");
  return value;
}

export function useFiles(): FilesContextValue {
  const value = useContext(FilesContext);
  if (!value) throw new Error("FilesContext is not available");
  return value;
}

export function useChanges(): ChangesContextValue {
  const value = useContext(ChangesContext);
  if (!value) throw new Error("ChangesContext is not available");
  return value;
}

export function useObservatory(): ObservatoryContextValue {
  const value = useContext(ObservatoryContext);
  if (!value) throw new Error("ObservatoryContext is not available");
  return value;
}

export function useWorkbenchShell(): WorkbenchShellContextValue {
  const value = useContext(WorkbenchShellContext);
  if (!value) throw new Error("WorkbenchShellContext is not available");
  return value;
}

export function useThreadStore(): ThreadStore {
  const value = useContext(ThreadStoreContext);
  if (!value) throw new Error("ThreadStoreContext is not available");
  return value;
}
