import { HostUnavailableError, errorMessage, type DesktopExtension, type DesktopExtensionContext } from "tau";
import { KEYBINDINGS_HOST_EXTENSION_ID, type PiKeybindingsState, type PiShortcutsState } from "./protocol.js";

/**
 * Tau's chords for the workbench commands, and the Pi action whose entry in
 * `~/.pi/agent/keybindings.json` replaces each of them when the user set one.
 * The commands themselves belong to whoever registered them; this kit only
 * decides which keys reach them.
 */
const RUNTIME_KEYBINDINGS: ReadonlyArray<{ commandId: string; keys?: string; piAction?: string }> = [
  { commandId: "runtime.command-palette", keys: "mod+k" },
  { commandId: "runtime.new-session", keys: "mod+n", piAction: "app.session.new" },
  { commandId: "runtime.abort", keys: "escape", piAction: "app.interrupt" },
  { commandId: "runtime.model", piAction: "app.model.select" },
  { commandId: "runtime.toggle-thinking", piAction: "app.thinking.toggle" },
];

// No host, or a host without this kit's entry (safe mode): Tau's chords stay.
const ignoreHostUnavailable = (error: unknown) => {
  if (error instanceof HostUnavailableError || /is not installed/u.test(errorMessage(error))) return;
  console.warn("Pi keybindings are unavailable", error);
};

function bindRuntimeKeys(plugin: DesktopExtensionContext, isDisposed: () => boolean): void {
  const defaults = new Map<string, () => void>();
  for (const entry of RUNTIME_KEYBINDINGS) {
    if (entry.keys) defaults.set(entry.commandId, plugin.registerKeybinding({ keys: entry.keys, commandId: entry.commandId }));
  }
  void plugin.host.invoke("pi-keybindings").then((state) => {
    if (isDisposed()) return;
    const bindings = (state as PiKeybindingsState).bindings;
    for (const entry of RUNTIME_KEYBINDINGS) {
      const keys = entry.piAction ? bindings[entry.piAction] : undefined;
      if (!keys?.length) continue;
      defaults.get(entry.commandId)?.();
      for (const chord of keys) {
        try { plugin.registerKeybinding({ keys: chord, commandId: entry.commandId }); } catch (error) { console.warn(`keybindings.json: ${entry.piAction} = ${chord} is not a chord Tau understands`, error); }
      }
    }
  }).catch(ignoreHostUnavailable);
}

/** Shortcuts Pi extensions registered: a palette command each, bound to the same chord. */
function bindPiShortcuts(plugin: DesktopExtensionContext, isDisposed: () => boolean): () => void {
  let disposers: Array<() => void> = [];
  const clear = () => { disposers.forEach((dispose) => dispose()); disposers = []; };
  const refresh = (sessionId?: string) => plugin.host.invoke("shortcuts", sessionId ? { sessionId } : undefined).then((state) => {
    if (isDisposed()) return;
    clear();
    for (const shortcut of (state as PiShortcutsState).shortcuts) {
      const id = `pi.shortcut.${shortcut.keys}`;
      try {
        disposers.push(plugin.registerCommand({
          id,
          label: shortcut.description ?? `Pi shortcut ${shortcut.keys}`,
          group: "Pi",
          run: async (app) => {
            try { await plugin.host.invoke("run-shortcut", { keys: shortcut.keys, sessionId: app.activeThread()?.sessionId }); } catch (error) { app.notify(errorMessage(error)); }
          },
        }));
        disposers.push(plugin.registerKeybinding({ keys: shortcut.keys, commandId: id }));
      } catch (error) {
        console.warn(`Pi shortcut ${shortcut.keys} from ${shortcut.source} could not be bound`, error);
      }
    }
  }).catch(ignoreHostUnavailable);
  void refresh();
  plugin.events.on("active-thread-changed", (event) => void refresh(event.sessionId));
  return clear;
}

/**
 * Keybindings' desktop half: Tau's own chords, whatever `keybindings.json`
 * puts in their place, and one palette command per Pi extension shortcut.
 */
export const keybindingsExtension: DesktopExtension = {
  id: KEYBINDINGS_HOST_EXTENSION_ID,
  name: "Keybindings",
  activate(plugin) {
    let disposed = false;
    bindRuntimeKeys(plugin, () => disposed);
    const clearShortcuts = bindPiShortcuts(plugin, () => disposed);
    return () => { disposed = true; clearShortcuts(); };
  },
};

export default keybindingsExtension;
