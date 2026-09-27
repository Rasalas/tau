import { createContext, useContext, useSyncExternalStore } from "react";
import type { AppPageState, AppPageStore } from "../workbench/app-page-store";

export const AppPageContext = createContext<AppPageStore | undefined>(undefined);

const noPage = () => undefined;
const noSubscription = () => () => {};

/** The app page on screen, if any; undefined outside a workbench. */
export function useOpenPage(): AppPageState | undefined {
  const store = useContext(AppPageContext);
  return useSyncExternalStore(store?.subscribe ?? noSubscription, store?.getSnapshot ?? noPage);
}

export function useAppPageStore(): AppPageStore | undefined {
  return useContext(AppPageContext);
}
