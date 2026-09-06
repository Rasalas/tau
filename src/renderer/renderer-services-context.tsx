import { createContext, useContext, type ReactNode } from "react";
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
