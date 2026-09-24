import { createContext, useContext, type ComponentType, type ReactNode } from "react";
import { parseClientProfile, type ClientProfile } from "../workbench/client-profile";
import { createElectronPlatform } from "./platform-electron";
import type { ClientPlatformFactory } from "./client-platform";

/**
 * The three facts a workbench cannot work out for itself: which client it is,
 * whether it was started without kits, and how to reach the machine it runs on.
 * `main.tsx` decides them once — the Electron one from its window's query
 * string, the web one from the page it was served on — and everything below
 * reads them here rather than from `window`.
 */
export interface ClientEnvironment {
  /** What this client claims to draw (ADR 0016). Fixed for the life of the page. */
  profile: ClientProfile;
  /** Started without kits: a workbench with a command palette and nothing else. */
  safeMode: boolean;
  createPlatform: ClientPlatformFactory;
  /** What the app around the workbench adds, where there is one (the native app). */
  shell?: ClientShell;
}

/**
 * A native shell that knows several hosts names the one on screen and offers
 * its own few actions (switch host). The compact thread list shows both.
 */
export interface ClientShell {
  /** The host this workbench talks to, as the shell calls it. */
  hostLabel?: string;
  /** At the end of the thread list's More menu. */
  actions?: ClientShellAction[];
}

export interface ClientShellAction {
  id: string;
  label: string;
  Icon?: ComponentType<{ size?: number }>;
  run(): void;
}

const ClientEnvironmentContext = createContext<ClientEnvironment | undefined>(undefined);

export function ClientEnvironmentProvider({ environment, children }: { environment: ClientEnvironment; children: ReactNode }) {
  return <ClientEnvironmentContext.Provider value={environment}>{children}</ClientEnvironmentContext.Provider>;
}

/**
 * The Electron window's own answer, and the one every existing test gets: the
 * desktop profile unless `?profile=` names another, so the desktop window can
 * show what a smaller client would leave out before opening one.
 */
export function electronClientEnvironment(search: URLSearchParams): ClientEnvironment {
  return {
    profile: parseClientProfile(search.get("profile")) ?? "desktop",
    safeMode: search.get("safeMode") === "1",
    createPlatform: createElectronPlatform,
  };
}

let ambient: { search: string; environment: ClientEnvironment } | undefined;

export function useClientEnvironment(): ClientEnvironment {
  const installed = useContext(ClientEnvironmentContext);
  if (installed) return installed;
  const search = window.location.search;
  if (ambient?.search !== search) ambient = { search, environment: electronClientEnvironment(new URLSearchParams(search)) };
  return ambient.environment;
}
