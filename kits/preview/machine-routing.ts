import type { HostMachineRoutingPolicy } from "tau/host-extension";
import { EMPTY_PREVIEW_STATE, PREVIEW_STATE_EVENT, type PreviewState } from "./protocol.js";

/** A browser on another machine is shown here through its frame/input commands. */
function frameState(value: unknown, machine: string): unknown {
  if (!value || typeof value !== "object" || typeof (value as PreviewState).url !== "string" || !Array.isArray((value as PreviewState).consoleErrors)) return value;
  const state = value as PreviewState;
  return { ...state, surface: "headless", ...(state.driver ? { driver: { ...state.driver, threadId: `${machine}~${state.driver.threadId}` } } : {}) };
}

export function previewMachineRouting(): HostMachineRoutingPolicy {
  return {
    // Native views report to the machine that owns that view. Their bounds
    // must never place another machine's view over its owner's window.
    localCommands: ["bounds", "view-changed", "view-chord", "cookie-import-settled", "smoke-diagnostics"],
    create(context) {
      const states = new Map<string, unknown>();
      const remember = (machine: string, value: unknown) => {
        const state = frameState(value, machine);
        if (state !== value) states.set(machine, state);
        return state;
      };
      return {
        route: () => context.activeMachine() ?? null,
        remoteResult: (machine, _command, _input, result) => remember(machine, result),
        remoteEvent: (machine, name, payload) => name === PREVIEW_STATE_EVENT ? remember(machine, payload) : payload,
        localEvent: (name, payload) => {
          const machine = context.activeMachine();
          return name === PREVIEW_STATE_EVENT && machine ? states.get(machine) ?? { ...EMPTY_PREVIEW_STATE, surface: "headless" } : payload;
        },
      };
    },
  };
}
