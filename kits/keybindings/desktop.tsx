import { HostUnavailableError, errorMessage, type DesktopExtension, type DesktopExtensionContext } from "tau";
import { KEYBINDINGS_HOST_EXTENSION_ID, type PiKeybindingsState, type PiShortcutsState } from "./protocol.js";

/**
 * The Pi actions in `~/.pi/agent/keybindings.json` and the workbench command
 * each one reaches. Core binds Tau's own chords for these commands; a chord
 * the user wrote for one of them replaces Tau's, because someone who rebound
 * `app.session.new` meant that key and not that key as well (`replaces` on
 * `registerKeybinding`). The commands belong to whoever registered them; this
 * kit only decides which keys reach them.
 */
const PI_KEYBINDINGS: ReadonlyArray<{ commandId: string; piAction: string }> = [
  { commandId: "runtime.new-session", piAction: "app.session.new" },
  { commandId: "runtime.abort", piAction: "app.interrupt" },
  { commandId: "runtime.model", piAction: "app.model.select" },
  // Pi's thinking toggle is Tau's transcript detail: the level that shows reasoning.
  { commandId: "runtime.transcript-detail", piAction: "app.thinking.toggle" },
  { commandId: "runtime.thread-tree", piAction: "app.session.tree" },
  { commandId: "runtime.fork-thread", piAction: "app.session.fork" },
  { commandId: "runtime.instructions", piAction: "app.instructions.view" },
  { commandId: "runtime.instructions", piAction: "app.system.prompt" },
  { commandId: "runtime.command-palette", piAction: "app.palette.open" },
  { commandId: "runtime.command-palette", piAction: "app.command.palette" },
  { commandId: "workspace.open-prompt-editor", piAction: "app.editor.open" },
  { commandId: "runtime.copy-chat", piAction: "app.chat.copy" },
];

// No host, or a host without this kit's entry (safe mode): core's chords stay.
const ignoreHostUnavailable = (error: unknown) => {
  if (error instanceof HostUnavailableError || /is not installed/u.test(errorMessage(error))) return;
  console.warn("Pi keybindings are unavailable", error);
};

function bindPiKeys(plugin: DesktopExtensionContext, isDisposed: () => boolean): void {
  void plugin.host.invoke("pi-keybindings").then((state) => {
    if (isDisposed()) return;
    const bindings = (state as PiKeybindingsState).bindings;
    const actionToCommand = new Map<string, string>(
      PI_KEYBINDINGS.map((entry) => [entry.piAction, entry.commandId])
    );
    for (const [action, keys] of Object.entries(bindings)) {
      if (!keys?.length) continue;
      const commandId = actionToCommand.get(action) ?? action;
      for (const chord of keys) {
        try {
          plugin.registerKeybinding({ keys: chord, commandId, replaces: commandId });
        } catch (error) {
          console.warn(`keybindings.json: ${action} = ${chord} is not a chord Tau understands`, error);
        }
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
 * Keybindings' desktop half: whatever `keybindings.json` adds beside Tau's own
 * chords, and one palette command per Pi extension shortcut.
 */
export const keybindingsExtension: DesktopExtension = {
  id: KEYBINDINGS_HOST_EXTENSION_ID,
  name: "Keybindings",
  activate(plugin) {
    let disposed = false;
    bindPiKeys(plugin, () => disposed);
    const clearShortcuts = bindPiShortcuts(plugin, () => disposed);
    return () => { disposed = true; clearShortcuts(); };
  },
};

export default keybindingsExtension;
