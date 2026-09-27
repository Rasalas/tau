/** Which chord sends: Enter, ⌘Enter once the draft has several lines, or ⌘Enter always. */
export type SendShortcut = "enter" | "mod-enter-multiline" | "mod-enter";
export type StreamingDelivery = "followUp" | "steer";

export const SEND_SHORTCUTS: readonly SendShortcut[] = ["enter", "mod-enter-multiline", "mod-enter"];

/**
 * The chord that sends on the keyboard typing now. An on-screen keyboard has
 * one return key and no ⇧: it writes a newline and the button sends. A
 * hardware keyboard on a touch screen, with none slid in over the page, sends
 * the way the desktop does.
 */
export function sendShortcutFor(preferred: SendShortcut | undefined, keyboard: { touch: boolean; onScreen: boolean }): SendShortcut {
  return keyboard.touch && keyboard.onScreen ? "mod-enter" : preferred ?? "enter";
}

const needsModifier = (shortcut: SendShortcut, text: string) =>
  shortcut === "mod-enter" || (shortcut === "mod-enter-multiline" && text.includes("\n"));

/**
 * What Enter does: a newline, or a send. While a turn runs the send carries a
 * delivery: `base` for the send chord, the other one for the alternate chord
 * (⌘ when Enter sends, ⇧ when ⌘Enter does); with no turn running, the
 * alternate chord asks for the `alternate` delivery.
 */
export function composerEnter(input: {
  shift: boolean;
  mod: boolean;
  shortcut: SendShortcut;
  text: string;
  streaming: boolean;
  base: StreamingDelivery;
}): "newline" | { delivery?: StreamingDelivery | "alternate" } {
  const modifier = needsModifier(input.shortcut, input.text);
  if (modifier ? !input.mod : input.shift) return "newline";
  const alternate = modifier ? input.shift : input.mod;
  // With no turn running the alternate chord is the composer's own "alternate" send (start in the background).
  if (!input.streaming) return alternate ? { delivery: "alternate" } : {};
  return { delivery: alternate === (input.base === "steer") ? "followUp" : "steer" };
}

/** The placeholder's key hints for the send chord and the running-turn choice; a touch keyboard gets none. */
export function sendHint(shortcut: SendShortcut, streaming: boolean, base: StreamingDelivery, touch = false): string {
  if (touch) return !streaming ? "Direct the agent" : base === "steer" ? "Steer this turn" : "Queue after this turn";
  const send = shortcut === "mod-enter" ? "⌘↵" : "↵";
  const other = shortcut === "mod-enter" ? "⌘⇧↵" : "⌘↵";
  if (!streaming) return `Direct the agent — $ skills, / commands, @ files, ${shortcut === "mod-enter" ? "⌘↵ sends" : "⇧↵ newline"}`;
  return base === "steer"
    ? `Steer this turn — ${send} steers now, ${other} queues, ⌥↑ dequeues`
    : `Queue after this turn — ${send} queues, ${other} steers now, ⌥↑ dequeues`;
}
