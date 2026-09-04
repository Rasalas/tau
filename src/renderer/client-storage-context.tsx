import { createContext, useContext, type ReactNode } from "react";
import type { ClientStorage } from "./client-storage";

const ClientStorageReactContext = createContext<ClientStorage | undefined>(undefined);

export function ClientStorageProvider({ storage, children }: { storage: ClientStorage; children: ReactNode }) {
  return <ClientStorageReactContext.Provider value={storage}>{children}</ClientStorageReactContext.Provider>;
}

/** For components. Non-component singletons (a store built at module scope) use `getClientStorage` instead. */
export function useClientStorage(): ClientStorage {
  const storage = useContext(ClientStorageReactContext);
  if (!storage) throw new Error("useClientStorage: no ClientStorageProvider above this component");
  return storage;
}
