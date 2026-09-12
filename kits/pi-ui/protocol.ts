/**
 * Wire between the Pi UI kit's host entry, which receives what Pi extensions
 * draw through `ctx.ui`, and its desktop half, which shows it in the status
 * line and around the composer.
 */
export const PI_UI_HOST_EXTENSION_ID = "tau.pi-ui";
/** Emitted with a `PiUiThreadState` whenever a thread's drawings change. */
export const PI_UI_EVENT = "state";

/** Mirrors `HostUiPresenter`'s placement; the protocol file stays import-free. */
export type PiUiWidgetPlacement = "aboveEditor" | "belowEditor";

export interface PiUiWidget {
  key: string;
  lines: string[];
  placement: PiUiWidgetPlacement;
}

export interface PiUiThreadState {
  sessionId: string;
  statuses: Array<{ key: string; text: string }>;
  widgets: PiUiWidget[];
  working?: string;
  footer?: string[];
  header?: string[];
  editorAction?: { type: "set" | "paste"; text: string; actionId: string };
  toolsExpanded?: boolean;
}

export const EMPTY_PI_UI_STATE = (sessionId: string): PiUiThreadState => ({ sessionId, statuses: [], widgets: [] });
