import type { HostExtension, HostExtensionContext } from "tau/host-extension";
import { EMPTY_PI_UI_STATE, PI_UI_EVENT, PI_UI_HOST_EXTENSION_ID, type PiUiThreadState } from "./protocol.js";

const optionalString = (input: unknown, key: string): string | undefined => {
  const value = input && typeof input === "object" ? (input as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" ? value : undefined;
};

/**
 * Host entry of the Pi UI kit: keeps what Pi extensions drew through
 * `ctx.ui.setStatus`, `setWidget` and `setWorkingMessage` per thread and
 * publishes every change to the desktop half.
 */
export function createPiUiHostExtension(): HostExtension {
  return {
    id: PI_UI_HOST_EXTENSION_ID,
    name: "Pi UI",
    permissions: ["runtime:extend", "sessions"],
    activate(context: HostExtensionContext) {
      const threads = new Map<string, PiUiThreadState>();
      const stateOf = (sessionId: string) => threads.get(sessionId) ?? EMPTY_PI_UI_STATE(sessionId);
      const publish = (state: PiUiThreadState) => {
        const isEmpty = state.statuses.length === 0 && state.widgets.length === 0 && state.working === undefined && state.footer === undefined && state.header === undefined && state.editorAction === undefined && state.toolsExpanded === undefined;
        if (isEmpty) threads.delete(state.sessionId);
        else threads.set(state.sessionId, state);
        context.emit(PI_UI_EVENT, state);
      };
      const stopPresenting = context.services.presentUi({
        setStatus: (sessionId, key, text) => {
          const state = stateOf(sessionId);
          const statuses = state.statuses.filter((status) => status.key !== key);
          publish({ ...state, statuses: text === undefined ? statuses : [...statuses, { key, text }] });
        },
        setWidget: (sessionId, key, lines, placement) => {
          const state = stateOf(sessionId);
          const widgets = state.widgets.filter((widget) => widget.key !== key);
          publish({ ...state, widgets: lines === undefined ? widgets : [...widgets, { key, lines, placement }] });
        },
        setWorkingMessage: (sessionId, message) => {
          const { working: _previous, ...state } = stateOf(sessionId);
          publish(message === undefined ? state : { ...state, working: message });
        },
        setFooter: (sessionId, lines) => {
          const state = stateOf(sessionId);
          publish({ ...state, footer: lines });
        },
        setHeader: (sessionId, lines) => {
          const state = stateOf(sessionId);
          publish({ ...state, header: lines });
        },
        setEditorText: (sessionId, text) => {
          const state = stateOf(sessionId);
          publish({ ...state, editorAction: { type: "set", text, actionId: `${Date.now()}-${Math.random()}` } });
        },
        pasteToEditor: (sessionId, text) => {
          const state = stateOf(sessionId);
          publish({ ...state, editorAction: { type: "paste", text, actionId: `${Date.now()}-${Math.random()}` } });
        },
        setToolsExpanded: (sessionId, expanded) => {
          const state = stateOf(sessionId);
          publish({ ...state, toolsExpanded: expanded });
        },
        clear: (sessionId) => {
          if (threads.has(sessionId)) publish(EMPTY_PI_UI_STATE(sessionId));
        },
      });
      context.registerCommand("state", (input) => {
        const sessionId = optionalString(input, "sessionId") ?? context.services.thread()?.sessionId;
        return sessionId ? stateOf(sessionId) : undefined;
      }, { access: "read" });
      return stopPresenting;
    },
  };
}

export default createPiUiHostExtension;
