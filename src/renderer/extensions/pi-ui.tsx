import { useSyncExternalStore } from "react";
import { EMPTY_PI_UI_STATE, PI_UI_EVENT, PI_UI_HOST_EXTENSION_ID, type PiUiThreadState, type PiUiWidgetPlacement } from "../../shared/pi-ui-protocol";
import { HostUnavailableError, type DesktopExtension, type RegionProps } from "../extension-system";

// Pi themes colour widget lines with ANSI sequences; the workbench shows plain text.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;
export const stripAnsi = (text: string): string => text.replace(ANSI, "");

function isThreadState(value: unknown): value is PiUiThreadState {
  const state = value as Partial<PiUiThreadState> | null;
  return Boolean(state && typeof state.sessionId === "string" && Array.isArray(state.statuses) && Array.isArray(state.widgets));
}

/** What each thread's Pi extensions drew; the components show the active thread's. */
export class PiUiStore {
  private threads = new Map<string, PiUiThreadState>();
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): ReadonlyMap<string, PiUiThreadState> => this.threads;

  set(state: PiUiThreadState): void {
    const next = new Map(this.threads);
    if (state.statuses.length === 0 && state.widgets.length === 0 && state.working === undefined) next.delete(state.sessionId);
    else next.set(state.sessionId, state);
    this.threads = next;
    this.listeners.forEach((listener) => listener());
  }
}

export function usePiUiThread(store: PiUiStore, sessionId: string | undefined): PiUiThreadState {
  const threads = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return (sessionId && threads.get(sessionId)) || EMPTY_PI_UI_STATE(sessionId ?? "");
}

export function createPiUiComponents(store: PiUiStore) {
  function PiStatusItems({ snapshot }: RegionProps) {
    const state = usePiUiThread(store, snapshot?.sessionId);
    if (state.statuses.length === 0 && state.working === undefined) return null;
    return (
      <>
        {state.working !== undefined && snapshot?.isStreaming ? <span className="pi-ui-working" title="Working message from a Pi extension">{stripAnsi(state.working)}</span> : null}
        {state.statuses.map((status) => <span className="pi-ui-status" key={status.key} title={status.key}>{stripAnsi(status.text)}</span>)}
      </>
    );
  }
  function widgets(placement: PiUiWidgetPlacement) {
    return function PiWidgets({ snapshot }: RegionProps) {
      const state = usePiUiThread(store, snapshot?.sessionId);
      const shown = state.widgets.filter((widget) => widget.placement === placement);
      if (shown.length === 0) return null;
      return (
        <>
          {shown.map((widget) => (
            <pre className="pi-ui-widget" key={widget.key} data-widget={widget.key}>{widget.lines.map(stripAnsi).join("\n")}</pre>
          ))}
        </>
      );
    };
  }
  return { PiStatusItems, PiWidgetsAbove: widgets("aboveEditor"), PiWidgetsBelow: widgets("belowEditor") };
}

/**
 * Shows what Pi extensions draw through `ctx.ui`: statuses and the working
 * message in the status line, text widgets above or below the composer.
 * Everything is per thread; the host forgets a thread's drawings with its runtime.
 */
export function createPiUiExtension(store = new PiUiStore()): DesktopExtension {
  return {
    id: PI_UI_HOST_EXTENSION_ID,
    name: "Pi UI",
    activate(plugin) {
      const { PiStatusItems, PiWidgetsAbove, PiWidgetsBelow } = createPiUiComponents(store);
      plugin.registerStatusItem({ id: "pi-ui.status", align: "right", order: 50, Component: PiStatusItems });
      plugin.registerRegion({ id: "pi-ui.widgets-above", placement: "composer-above", order: 50, Component: PiWidgetsAbove });
      plugin.registerRegion({ id: "pi-ui.widgets-below", placement: "composer-below", order: 50, Component: PiWidgetsBelow });
      plugin.host.onEvent(PI_UI_EVENT, (payload) => { if (isThreadState(payload)) store.set(payload); });
      // A reloaded renderer missed earlier drawings; ask the host for the thread's state.
      const read = (sessionId?: string) => plugin.host.invoke("state", sessionId ? { sessionId } : undefined)
        .then((value) => { if (isThreadState(value)) store.set(value); })
        .catch((error: unknown) => { if (!(error instanceof HostUnavailableError)) console.warn("Pi UI could not read the thread's drawings", error); });
      void read();
      plugin.events.on("active-thread-changed", (event) => void read(event.sessionId));
    },
  };
}

export const piUiExtension = createPiUiExtension();
