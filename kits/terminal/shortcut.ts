import { useWorkbenchShell } from "tau";
import { TERMINAL_COMMANDS } from "./protocol.js";

/** The chord a terminal command is bound to, as its button's hint: the live binding, so a rebinding shows and none shows nothing. */
export function useTerminalChord(): (command: keyof typeof TERMINAL_COMMANDS) => string | undefined {
  const { registry } = useWorkbenchShell();
  return (command) => registry.keybindingLabel(TERMINAL_COMMANDS[command]);
}

/** Terminal chords only apply with a shell focused: "⌘D in a terminal". */
export function inTerminal(chord: string | undefined): string | undefined {
  return chord ? `${chord} in a terminal` : undefined;
}
