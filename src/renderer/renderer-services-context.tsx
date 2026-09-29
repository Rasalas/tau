import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { AppUpdate } from "./app-update";
import type { RendererServices } from "./renderer-services";
import type { PreferencesStore } from "./preferences";

const RendererServicesReactContext = createContext<RendererServices | undefined>(undefined);

export function RendererServicesProvider({ services, children }: { services: RendererServices; children: ReactNode }) {
  return <RendererServicesReactContext.Provider value={services}>{children}</RendererServicesReactContext.Provider>;
}

export function useRendererServices(): RendererServices {
  const services = useContext(RendererServicesReactContext);
  if (!services) throw new Error("useRendererServices: no RendererServicesProvider above this component");
  return services;
}

export function usePreferences(): PreferencesStore {
  return useRendererServices().preferences;
}

const noUpdate = () => undefined;
const noSubscription = () => () => {};

/** The release the host downloaded and waits to restart into, or undefined (API 1.28.0). */
export function useAppUpdate(): AppUpdate | undefined {
  const store = useContext(RendererServicesReactContext)?.appUpdate;
  return useSyncExternalStore(store?.subscribe ?? noSubscription, store?.getSnapshot ?? noUpdate);
}
