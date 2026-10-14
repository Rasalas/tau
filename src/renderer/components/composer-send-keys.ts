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

/**
 * Which chord an Enter is: a newline, the send chord, or the alternate one
 * (⌘ when Enter sends, ⇧ when ⌘Enter does), which opens the send menu on a thread.
 */
export function enterChord(input: { shift: boolean; mod: boolean; shortcut: SendShortcut; text: string }): "newline" | "send" | "alternate" {
  const modifier = needsModifier(input.shortcut, input.text);
  if (modifier ? !input.mod : input.shift) return "newline";
  return (modifier ? input.shift : input.mod) ? "alternate" : "send";
}

/**
 * What the send button does now: its label, and on a keyboard its tooltip
 * with the chords around it. With `chooser` the alternate chord opens the
 * send menu, on the other delivery, instead of sending it at once.
 */
export function sendHint(shortcut: SendShortcut, streaming: boolean, base: StreamingDelivery, touch = false, chooser = false): { label: string; hint: string } {
  const label = !streaming ? "Send" : base === "steer" ? "Steer this turn" : "Queue after this turn";
  if (touch) return { label, hint: label };
  const send = shortcut === "mod-enter" ? "⌘↵" : "↵";
  const other = shortcut === "mod-enter" ? "⌘⇧↵" : "⌘↵";
  if (!streaming) return { label, hint: `Send ${send} — ${shortcut === "mod-enter" ? "↵" : "⇧↵"} newline, ${chooser ? `${other} plan, ` : ""}$ skills, / commands, @ files` };
  if (chooser) return { label, hint: `${label} ${send} — ${other} ${base === "steer" ? "queue" : "steer"} or plan, ⌥↑ dequeues` };
  return {
    label,
    hint: base === "steer"
      ? `Steer this turn ${send} — ${other} queues, ⌥↑ dequeues`
      : `Queue after this turn ${send} — ${other} steers now, ⌥↑ dequeues`,
  };
}

/**
 * Why sending does nothing right now, in the words of the button's tooltip and
 * of the notice a pressed key gets; undefined when it can go. An empty draft is
 * no reason: the button rests.
 */
export function sendBlockReason(state: {
  held: boolean;
  dictating: boolean;
  /** A question is about to open and takes the field once the typing stops. */
  asking: boolean;
  /** A kit's send mode is working; its own label ("Compacting…"). */
  busyLabel?: string | undefined;
  /** The previous message has not been handed over yet. */
  sending: boolean;
}): string | undefined {
  if (state.held) return "A workspace change is under way. Sending waits until it is done.";
  if (state.dictating) return "Dictation is on. Stop it to send.";
  if (state.asking) return "The agent is asking something. It opens once you stop typing.";
  if (state.busyLabel) return state.busyLabel;
  if (state.sending) return "Still sending the previous message.";
  return undefined;
}
