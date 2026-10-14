import { Paintbrush } from "lucide-react";
import type { DesktopExtension, RegionPlacement, WorkbenchActions } from "tau";
import { createCustomizeStore } from "./client-store.js";
import { createLayer, createScriptComponents, inlineTarget } from "./layer.js";
import { createPickerState, Picker } from "./picker.js";
import { CUSTOMIZE_EXTENSION_ID, type SharedData } from "./protocol.js";
import { CUSTOMIZE_SETTINGS_PAGE, CustomizeSettings } from "./settings.js";
import { mountUserStyles } from "./user-styles.js";

function isShared(value: unknown): value is SharedData {
  const data = value as Partial<SharedData> | null;
  return typeof data === "object" && data !== null && data.shared === true && typeof data.getSnapshot === "function" && typeof data.subscribe === "function";
}

/**
 * Customize: the user's own changes to every part of the workbench by its
 * name (ADR 0042) — hidden, ordered, moved or replaced by a script on the
 * sandbox frame — and their styles. Turning it off restores Tau as shipped.
 */
export const customizeExtension: DesktopExtension = {
  id: CUSTOMIZE_EXTENSION_ID,
  name: "Customize",
  activate(plugin) {
    const disposers: Array<() => void> = [];
    const store = createCustomizeStore(plugin.host);
    disposers.push(() => store.dispose());

    const context = {
      host: plugin.host,
      store,
      parts: () => plugin.customizableParts(),
      // A script reads only what a kit lent it as shared data, never another service.
      useShared: (id: string, use: (data: SharedData) => (() => void) | void) => plugin.useService<unknown>(id, (value) => (isShared(value) ? use(value) : undefined)),
    };
    const scriptComponent = createScriptComponents(context);
    disposers.push(plugin.registerCustomizations(createLayer(context, scriptComponent)));

    const styles = mountUserStyles();
    disposers.push(() => styles.dispose());

    // Scripts that add a part of their own: a region at their placement, kept while placement and order stay.
    const placed = new Map<string, { key: string; dispose(): void }>();
    const follow = () => {
      const state = store.getSnapshot();
      styles.set(state.styles);
      const wanted = new Set<string>();
      for (const script of state.scripts) {
        if (!script.enabled || !("placement" in script.target)) continue;
        const { placement, order } = script.target;
        const key = `${placement}:${String(order ?? 1000)}`;
        wanted.add(script.id);
        const held = placed.get(script.id);
        if (held?.key === key) continue;
        held?.dispose();
        const Component = scriptComponent(script.id, inlineTarget(placement, []));
        placed.set(script.id, {
          key,
          dispose: plugin.registerRegion({ id: `customize.script.${script.id}`, placement: placement as RegionPlacement, order: order ?? 1000, Component }),
        });
      }
      for (const [id, held] of placed) {
        if (!wanted.has(id)) { held.dispose(); placed.delete(id); }
      }
    };
    disposers.push(store.subscribe(follow));
    follow();
    disposers.push(() => { for (const held of placed.values()) held.dispose(); placed.clear(); });

    const picker = createPickerState();
    // The window's actions, for Settings' "Pick a part", which has none of its own.
    let windowActions: WorkbenchActions | undefined;
    plugin.registerRegion({
      id: "customize.picker",
      placement: "title-bar",
      profiles: ["desktop", "web"],
      Component: ({ actions }) => {
        windowActions = actions;
        return <Picker state={picker} actions={actions} parts={() => plugin.customizableParts()} />;
      },
    });
    const subscribeParts = (listener: () => void) => plugin.onPartsChanged(listener);

    plugin.registerSettingsPage({
      id: CUSTOMIZE_SETTINGS_PAGE,
      label: "Customize",
      profiles: ["desktop", "web", "compact"],
      description: "Hide, move or replace any part of Tau by its name, and add your own styles and scripts. They apply on every device of this machine.",
      Icon: Paintbrush,
      group: "app",
      order: 90,
      keywords: ["hide", "css", "style", "script", "user script", "theme", "part", "juicebars"],
      Component: (props) => (
        <CustomizeSettings
          {...props}
          store={store}
          parts={() => plugin.customizableParts()}
          subscribeParts={subscribeParts}
          {...(windowActions?.closeSettings ? { pick: () => { windowActions?.closeSettings?.(); picker.set(true); } } : {})}
        />
      ),
    });

    plugin.registerCommand({
      id: "customize.pick",
      label: "Customize a part…",
      group: "Extensions",
      access: "read",
      run: () => { picker.set(true); },
    });

    return () => { for (const dispose of disposers.reverse()) dispose(); };
  },
};

export default customizeExtension;
