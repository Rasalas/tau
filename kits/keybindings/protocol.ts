/**
 * Keybindings' contract between its host entry and its desktop entry. The host
 * side reads and writes Pi's `keybindings.json` and asks the thread's runtime
 * which shortcuts its Pi extensions registered; the desktop side turns both
 * into chords and palette commands of the workbench.
 */
export const KEYBINDINGS_HOST_EXTENSION_ID = "tau.keybindings";

/**
 * The chords the user set in `~/.pi/agent/keybindings.json`, by Pi action or
 * Tau command id. An entry written as `{ "key": …, "when": … }` (Tau only; Pi
 * skips it) carries its own `when` clause.
 */
export interface PiKeybindingsState {
  bindings: Record<string, Array<string | UserKeybinding>>;
  /** The file, with the home folder as `~`. */
  path?: string;
}

export interface UserKeybinding {
  key: string;
  when?: string;
}

/** `set-chords`: a command's new chords, or `null` for its defaults. */
export interface SetChordsInput {
  commandId: string;
  chords: UserKeybinding[] | null;
}

/**
 * The Pi actions in `keybindings.json` and the workbench command each one
 * reaches. An entry under the command id itself wins over these, so Tau can
 * rebind a command without changing Pi's own key.
 */
export const PI_KEYBINDINGS: ReadonlyArray<{ commandId: string; piAction: string }> = [
  { commandId: "runtime.new-session", piAction: "app.session.new" },
  { commandId: "runtime.abort", piAction: "app.interrupt" },
  { commandId: "runtime.model", piAction: "app.model.select" },
  { commandId: "runtime.cycle-model", piAction: "app.model.cycleForward" },
  { commandId: "runtime.cycle-model-backward", piAction: "app.model.cycleBackward" },
  { commandId: "runtime.cycle-thinking", piAction: "app.thinking.cycle" },
  // Pi's thinking toggle is Tau's transcript detail: the level that shows reasoning.
  { commandId: "runtime.transcript-detail", piAction: "app.thinking.toggle" },
  { commandId: "runtime.thread-tree", piAction: "app.session.tree" },
  { commandId: "runtime.fork-thread", piAction: "app.session.fork" },
  { commandId: "runtime.rename-thread", piAction: "app.session.rename" },
  { commandId: "runtime.instructions", piAction: "app.instructions.view" },
  { commandId: "runtime.instructions", piAction: "app.system.prompt" },
  { commandId: "runtime.command-palette", piAction: "app.palette.open" },
  { commandId: "runtime.command-palette", piAction: "app.command.palette" },
  { commandId: "workspace.open-prompt-editor", piAction: "app.editor.open" },
  { commandId: "workspace.open-prompt-editor", piAction: "app.editor.external" },
  { commandId: "runtime.copy-chat", piAction: "app.chat.copy" },
  { commandId: "runtime.copy-chat", piAction: "app.message.copy" },
  { commandId: "workbench.focus-transcript", piAction: "tui.altScreen.top" },
  { commandId: "workbench.focus-composer", piAction: "tui.altScreen.bottom" },
];

export const PI_ACTION_COMMANDS: ReadonlyMap<string, string> = new Map(PI_KEYBINDINGS.map((entry) => [entry.piAction, entry.commandId]));

/** Pi's own action ids; every other key in the file is a Tau command id. */
export function isPiAction(id: string): boolean {
  return /^(?:app|tui)\./u.test(id);
}

/** A shortcut a Pi extension registered for a thread's runtime. */
export interface PiShortcut {
  /** Pi chord spelling, lowercased, e.g. "ctrl+shift+p". */
  keys: string;
  description?: string;
  /** The extension file that registered it. */
  source: string;
}

export interface PiShortcutsState {
  sessionId?: string;
  shortcuts: PiShortcut[];
}
