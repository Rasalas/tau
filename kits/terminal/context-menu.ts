import type { MenuSection } from "tau";

export type TerminalMenuChoice = "copy" | "paste" | "select-all" | "scroll-to-bottom";

const isChoice = (id: string | undefined): id is TerminalMenuChoice => id === "copy" || id === "paste" || id === "select-all" || id === "scroll-to-bottom";
export const terminalMenuChoice = (id: string | undefined): TerminalMenuChoice | undefined => isChoice(id) ? id : undefined;

/**
 * The right-click menu of a terminal view (T3 #17091). Copy waits for a
 * selection, Paste for a shell that takes input; the hints are the chords the
 * view itself answers (`terminalNavigation`).
 */
export function terminalMenuSections(state: { hasSelection: boolean; canType: boolean; mac: boolean }): MenuSection[] {
  return [
    { items: [
      { id: "copy", label: "Copy", disabled: !state.hasSelection },
      { id: "paste", label: "Paste", disabled: !state.canType },
    ] },
    { items: [
      { id: "select-all", label: "Select all", hint: state.mac ? "⌘A" : "Ctrl+Shift+A" },
      { id: "scroll-to-bottom", label: "Jump to latest", hint: state.mac ? "⌘End" : "Ctrl+Shift+End" },
    ] },
  ];
}
