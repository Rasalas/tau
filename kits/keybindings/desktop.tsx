import { HostUnavailableError, errorMessage, type DesktopExtension, type DesktopExtensionContext } from "tau";
import { KEYBINDINGS_HOST_EXTENSION_ID, PI_ACTION_COMMANDS, type PiKeybindingsState, type PiShortcutsState, type SetChordsInput } from "./protocol.js";

// No host, or a host without this kit's entry (safe mode): core's chords stay.
const ignoreHostUnavailable = (error: unknown) => {
  if (error instanceof HostUnavailableError || /is not installed/u.test(errorMessage(error))) return;
  console.warn("Pi keybindings are unavailable", error);
};

/**
 * Binds what `keybindings.json` holds. Core binds Tau's own chords; a chord the
 * user wrote for one of those commands replaces Tau's, because someone who
 * rebound `app.session.new` meant that key and not that key as well
 * (`replaces` on `registerKeybinding`). The commands belong to whoever
 * registered them; this kit only decides which keys reach them.
 */
function bindPiKeys(plugin: DesktopExtensionContext, isDisposed: () => boolean, onRead: (state: PiKeybindingsState) => void): { refresh: () => Promise<void>; clear: () => void } {
  let disposers: Array<() => void> = [];
  const clear = () => { disposers.forEach((dispose) => dispose()); disposers = []; };
  const refresh = () => plugin.host.invoke("pi-keybindings").then((state) => {
    if (isDisposed()) return;
    // The file is the whole truth about these chords, so a re-read replaces
    // what the last one bound rather than adding to it.
    clear();
    const { bindings } = state as PiKeybindingsState;
    const ownEntries = new Set(Object.keys(bindings).filter((id) => !PI_ACTION_COMMANDS.has(id)));
    for (const [action, keys] of Object.entries(bindings)) {
      const commandId = PI_ACTION_COMMANDS.get(action) ?? action;
      if (!keys?.length || (action !== commandId && ownEntries.has(commandId))) continue;
      for (const entry of keys) {
        // Without `when` a rebound key keeps the context of the default it replaces.
        const { key, when } = typeof entry === "string" ? { key: entry, when: undefined } : entry;
        try {
          disposers.push(plugin.registerKeybinding({ keys: key, commandId, replaces: commandId, ...(when !== undefined ? { when } : {}) }));
        } catch (error) {
          console.warn(`keybindings.json: ${action} = ${key} is not a chord Tau understands`, error);
        }
      }
    }
    onRead(state as PiKeybindingsState);
  }).catch(ignoreHostUnavailable);
  void refresh();
  return { refresh, clear };
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
 * Keybindings' desktop half: whatever `keybindings.json` adds beside Tau's own
 * chords, and one palette command per Pi extension shortcut.
 */
export const keybindingsExtension: DesktopExtension = {
  id: KEYBINDINGS_HOST_EXTENSION_ID,
  name: "Keybindings",
  activate(plugin) {
    let disposed = false;
    let keymap: (() => void) | undefined;
    const piKeys = bindPiKeys(plugin, () => disposed, (state) => {
      // Settings → Keybindings writes here once the host has answered.
      keymap ??= plugin.registerUserKeymap({
        id: "keybindings-json",
        label: state.path ?? "keybindings.json",
        setChords: async (commandId, chords) => {
          const input: SetChordsInput = { commandId, chords: chords ? [...chords] : null };
          await plugin.host.invoke("set-chords", input);
          await piKeys.refresh();
        },
        resetAll: async () => {
          await plugin.host.invoke("reset-chords");
          await piKeys.refresh();
        },
      });
    });
    const clearShortcuts = bindPiShortcuts(plugin, () => disposed);
    // The host half hears that keybindings.json moved and says so here.
    const stopWatching = plugin.host.onEvent("changed", () => piKeys.refresh());
    return () => { disposed = true; stopWatching(); piKeys.clear(); clearShortcuts(); keymap?.(); };
  },
};

export default keybindingsExtension;
