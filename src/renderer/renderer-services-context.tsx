import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";
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

/** Diff presentation follows the same preferences in file tabs and review pages. */
export function useDiffPresentation() {
  const preferences = useContext(RendererServicesReactContext)?.preferences;
  useSyncExternalStore(preferences?.subscribe ?? noSubscription, preferences?.getSnapshot ?? noUpdate);
  const [localLayout, setLocalLayout] = useState<"unified" | "split">("unified");
  const [localWrap, setLocalWrap] = useState(true);
  const layout = preferences ? preferences.optionValue("tau.review", "split-diff", false) ? "split" : "unified" : localLayout;
  const wrap = preferences ? preferences.optionValue("tau.review", "diff-word-wrap", true) : localWrap;
  return {
    layout,
    wrap,
    setLayout: (next: "unified" | "split") => { if (preferences) preferences.setOption("tau.review", "split-diff", next === "split"); else setLocalLayout(next); },
    setWrap: (next: boolean) => { if (preferences) preferences.setOption("tau.review", "diff-word-wrap", next); else setLocalWrap(next); },
  };
}
