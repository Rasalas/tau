import { useEffect, useRef, useSyncExternalStore } from "react";
import { HostUnavailableError, hostHasLocalFiles, type HostExtensionClient, type RegionProps, type WorkbenchActions } from "tau";
import { EMPTY_PREVIEW_STATE, createPreviewHostClient, type PreviewState } from "./protocol.js";
import { Cell, previewView, useScreenFollower } from "./screen-store.js";

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

/**
 * This client shows frames of the host's page rather than a view of its own:
 * a browser or a phone (even on the host's machine), or a desktop window on
 * another computer. The workbench names the client's profile on `<body>`.
 */
export function drawsFrames(): boolean {
  const client = typeof document === "undefined" ? undefined : document.body.dataset.client;
  return (client !== undefined && client !== "desktop") || !hostHasLocalFiles();
}

/**
 * Whether the Preview panel is on screen in this window: `preview.toggle`
 * reads it, and the floating preview shows only while it is not.
 */
export const panelShown = new Cell(false);

export function notePanelShown(shown: boolean): void {
  panelShown.set(shown);
}

export function togglePreviewPanel(actions: Pick<WorkbenchActions, "openPanel" | "toggleDock">): void {
  if (panelShown.get()) actions.toggleDock();
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

/** A host from before this version sends no zoom, viewport or floating-preview fields. */
export function readPreviewState(value: PreviewState): PreviewState {
  return { ...EMPTY_PREVIEW_STATE, ...value };
}

export function usePreviewState(store: PreviewStore = previewStore): PreviewState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** The workbench's actions, for what runs outside a component: a link click that opens the panel. */
export const workbenchActions = new Cell<WorkbenchActions | undefined>(undefined);

/** Brings the panel forward when the agent points the preview at a new page or drives a new window. */
export function PreviewFollower({ actions, workspacePreviewAvailable = false }: RegionProps): null {
  const state = usePreviewState();
  useEffect(() => {
    workbenchActions.set(actions);
    return () => { if (workbenchActions.get() === actions) workbenchActions.set(undefined); };
  }, [actions]);
  useScreenFollower(actions, PREVIEW_PANEL, workspacePreviewAvailable);
  const shown = useRef("");
  useEffect(() => {
    if (!state.url || state.url === shown.current) return;
    shown.current = state.url;
    previewView.set("browser");
    if (!workspacePreviewAvailable) actions.openPanel(PREVIEW_PANEL);
  }, [actions, state.url, workspacePreviewAvailable]);
  return null;
}
