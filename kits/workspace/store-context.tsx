import { createContext, useContext, useSyncExternalStore, type ComponentType } from "react";
import type { WorkspaceKitState } from "./protocol.js";
import type { WorkspaceStore } from "./store.js";

/**
 * The kit owns its store, so it also owns the way its components find it. Core
 * lends slots, not state: every component the kit registers is wrapped in
 * `withWorkspaceStore` at activation, which is the only place the instance
 * created there is bound.
 */
const WorkspaceStoreContext = createContext<WorkspaceStore | undefined>(undefined);

export function useWorkspaceStore(): WorkspaceStore {
  const store = useContext(WorkspaceStoreContext);
  if (!store) throw new Error("useWorkspaceStore: this component was not registered through withWorkspaceStore");
  return store;
}

export function useWorkspaceKit(): WorkspaceKitState {
  const store = useWorkspaceStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function withWorkspaceStore<P extends object>(store: WorkspaceStore, Component: ComponentType<P>): ComponentType<P> {
  return function WithWorkspaceStore(props: P) {
    return <WorkspaceStoreContext.Provider value={store}><Component {...props} /></WorkspaceStoreContext.Provider>;
  };
}
