import { useEffect, useRef, useSyncExternalStore } from "react";
import { HostUnavailableError, type HostExtensionClient, type RegionProps, type WorkbenchActions } from "tau";
import { EMPTY_PREVIEW_STATE, createPreviewHostClient, type PreviewState } from "./protocol.js";
import { previewView, useScreenFollower } from "./screen-store.js";

/**
 * The kit's own host entry, handed over by `activate`. The panel is a React
 * component the workbench renders, not something the extension context reaches,
 * so the connection is a module binding rather than a prop.
 */
let connection: HostExtensionClient | undefined;

export function connectPreviewHost(host: HostExtensionClient): () => void {
  connection = host;
  return () => { if (connection === host) connection = undefined; };
}

/** Preview Kit's host entry, reached through the generic extension channel. */
export const previewKit = createPreviewHostClient((command, input) => connection
  ? connection.invoke(command, input)
  : Promise.reject(new HostUnavailableError()));

export const PREVIEW_PANEL = "preview";

/** Whether the Preview panel is on screen, which decides what `preview.toggle` does. */
let panelShown = false;

export function notePanelShown(shown: boolean): void {
  panelShown = shown;
}

export function togglePreviewPanel(actions: Pick<WorkbenchActions, "openPanel" | "toggleDock">): void {
  if (panelShown) actions.toggleDock();
  else actions.openPanel(PREVIEW_PANEL);
}

/** What the host's browser view currently shows; the panel renders from this. */
export class PreviewStore {
  private state: PreviewState = EMPTY_PREVIEW_STATE;

  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): PreviewState => this.state;

  set(state: PreviewState): void {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}

export const previewStore = new PreviewStore();

export function isPreviewState(value: unknown): value is PreviewState {
  const state = value as Partial<PreviewState> | null;
  return Boolean(state && typeof state.url === "string" && Array.isArray(state.consoleErrors));
}

export function usePreviewState(store: PreviewStore = previewStore): PreviewState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** Brings the panel forward when the agent points the preview at a new page or drives a new window. */
export function PreviewFollower({ actions }: RegionProps): null {
  const state = usePreviewState();
  useScreenFollower(actions, PREVIEW_PANEL);
  const shown = useRef("");
  useEffect(() => {
    if (!state.url || state.url === shown.current) return;
    shown.current = state.url;
    previewView.set("browser");
    actions.openPanel(PREVIEW_PANEL);
  }, [actions, state.url]);
  return null;
}
