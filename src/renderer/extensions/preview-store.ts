import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  EMPTY_PREVIEW_STATE,
  PREVIEW_HOST_EXTENSION_ID,
  createPreviewHostClient,
  type PreviewState,
} from "../../shared/preview-protocol";
import { HostUnavailableError, type RegionProps } from "../extension-system";
import { getHostClient } from "../host-client-context";

/** Preview Kit's host entry, reached through the generic extension channel. */
export const previewKit = createPreviewHostClient((command, input) => {
  const client = getHostClient();
  return client
    ? client.invokeHostExtension(PREVIEW_HOST_EXTENSION_ID, command, input)
    : Promise.reject(new HostUnavailableError());
});

export const PREVIEW_PANEL = "preview";

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

/** Brings the panel forward when the agent points the preview at a new page. */
export function PreviewFollower({ actions }: RegionProps): null {
  const state = usePreviewState();
  const shown = useRef("");
  useEffect(() => {
    if (!state.url || state.url === shown.current) return;
    shown.current = state.url;
    actions.openPanel(PREVIEW_PANEL);
  }, [actions, state.url]);
  return null;
}
