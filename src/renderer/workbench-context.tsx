import { createContext, useContext } from "react";
import type { HostEvent, HostSnapshot, UiToolRun } from "../shared/contracts";
import type { ExtensionRegistry, WorkbenchActions } from "./extension-system";
import type { ThreadStore } from "../workbench/thread-store";
export type { TimelineEvent } from "../workbench/thread-view-store";
import type { TimelineEvent } from "../workbench/thread-view-store";

export interface WorkbenchContextValue {
  snapshot?: HostSnapshot;
  tools: readonly UiToolRun[];
  events: readonly TimelineEvent[];
  registry: ExtensionRegistry;
  /** Absolute path of the document shown in the active stage tab. */
  activeDocumentPath?: string;
  openFile(path: string, options?: { pin?: boolean; view?: "source" | "diff"; line?: number }): void;
  applySnapshot(snapshot: HostSnapshot): void;
  handleHostEvent(event: HostEvent): void;
}

export interface WorkbenchShellContextValue {
  snapshot?: HostSnapshot;
  registry: ExtensionRegistry;
  actions?: WorkbenchActions;
}

export interface ObservatoryContextValue {
  events: readonly TimelineEvent[];
  snapshot?: HostSnapshot;
  tools: readonly UiToolRun[];
  registry: ExtensionRegistry;
}

export const WorkbenchContext = createContext<WorkbenchContextValue | undefined>(undefined);
export const ObservatoryContext = createContext<ObservatoryContextValue | undefined>(undefined);
export const WorkbenchShellContext = createContext<WorkbenchShellContextValue | undefined>(undefined);
export const ThreadStoreContext = createContext<ThreadStore | undefined>(undefined);

export function useWorkbench(): WorkbenchContextValue {
  const value = useContext(WorkbenchContext);
  if (!value) throw new Error("WorkbenchContext is not available");
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
