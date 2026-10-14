import { useSyncExternalStore, type ComponentType, type FunctionComponent } from "react";
import type { CustomizablePart, Customizations, CustomizationLayer, HostExtensionClient, RegionPlacement, WorkbenchActions } from "tau";
import type { CustomizeStore } from "./client-store.js";
import type { CustomizeState, UserScript } from "./protocol.js";
import { ScriptFrame, type UseShared } from "./script-frame.js";

// Placements whose parts sit in a row: a script there is as wide as it drew.
const ROW_PLACEMENTS = new Set<string>(["title-bar", "thread-title", "thread-branch", "thread-list-title", "composer-controls", "stage-bar", "draft-actions"]);

/** Whether a script in `name`'s place sits in a row rather than taking the width. */
export function inlineTarget(name: string, parts: readonly CustomizablePart[]): boolean {
  if (name.endsWith("/Summary") || name.startsWith("status:") || name.startsWith("composer-control:")) return true;
  if (ROW_PLACEMENTS.has(name)) return true;
  const part = parts.find((entry) => entry.name === name);
  return Boolean(part?.placement && ROW_PLACEMENTS.has(part.placement));
}

export interface LayerContext {
  host: HostExtensionClient;
  store: CustomizeStore;
  useShared: UseShared;
  parts(): CustomizablePart[];
}

function scriptOf(state: CustomizeState, id: string): UserScript | undefined {
  return state.scripts.find((entry) => entry.id === id && entry.enabled);
}

/** One component per script for its whole life, so an edit reloads the frame and never remounts the part. */
export function createScriptComponents(context: LayerContext) {
  const components = new Map<string, FunctionComponent<{ actions?: WorkbenchActions }>>();
  return (id: string, inline: boolean): FunctionComponent<{ actions?: WorkbenchActions }> => {
    const key = `${id}:${inline ? "inline" : "block"}`;
    const known = components.get(key);
    if (known) return known;
    function UserScriptPart({ actions }: { actions?: WorkbenchActions }) {
      const state = useSyncExternalStore(context.store.subscribe, context.store.getSnapshot);
      const script = scriptOf(state, id);
      if (!script) return null;
      return <ScriptFrame host={context.host} script={script} actions={actions} useShared={context.useShared} inline={inline} />;
    }
    UserScriptPart.displayName = `UserScript(${id})`;
    components.set(key, UserScriptPart);
    return UserScriptPart;
  };
}

/** The store as core's layer: hidden, order, placement, and every enabled replacing script. */
export function createLayer(context: LayerContext, scriptComponent: ReturnType<typeof createScriptComponents>): CustomizationLayer {
  let source: CustomizeState | undefined;
  let snapshot: Customizations = {};
  return {
    subscribe: context.store.subscribe,
    getSnapshot(): Customizations {
      const state = context.store.getSnapshot();
      if (state === source) return snapshot;
      source = state;
      const replaced: Record<string, ComponentType<any>> = {};
      const parts = context.parts();
      for (const script of state.scripts) {
        if (!script.enabled || !("replace" in script.target)) continue;
        replaced[script.target.replace] = scriptComponent(script.id, inlineTarget(script.target.replace, parts));
      }
      snapshot = {
        hidden: state.hidden,
        order: state.order,
        placement: state.placement as Record<string, RegionPlacement>,
        replaced,
      };
      return snapshot;
    },
  };
}
