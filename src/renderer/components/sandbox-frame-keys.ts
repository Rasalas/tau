import { FRAME_MAX_CHORDS, type FrameChord, type FrameKeyDown } from "../../shared/sandbox-frame";
import type { ExtensionRegistry } from "../extension-system";
import { isMacPlatform, platformChordId } from "../keybindings";

// A page may press what only changes the view (`access: "read"`) and the two
// commands that open an empty draft; nothing that changes a thread.
const DRAFT_COMMANDS = new Set(["runtime.new-session", "runtime.new-session-in"]);

const passable = (command: { id: string; access?: "read" | "write" }) => command.access === "read" || DRAFT_COMMANDS.has(command.id);

/**
 * The Cmd/Ctrl chords a framed document may pass on. A chord that any live
 * binding gives to another command stays with the document.
 */
export function frameChords(registry: ExtensionRegistry, mac = isMacPlatform()): FrameChord[] {
  const passed = new Map<string, FrameChord>();
  const kept = new Set<string>();
  for (const binding of registry.getKeybindings()) {
    const id = platformChordId(binding.chord, mac);
    const command = registry.getCommand(binding.commandId);
    const { chord } = binding;
    const metaKey = chord.meta || (chord.mod && mac);
    const ctrlKey = chord.ctrl || (chord.mod && !mac);
    if (!command || !passable(command)) { kept.add(id); continue; }
    if (metaKey || ctrlKey) passed.set(id, { key: chord.key, metaKey, ctrlKey, shiftKey: chord.shift, altKey: chord.alt });
  }
  return [...passed].filter(([id]) => !kept.has(id)).map(([, chord]) => chord).slice(0, FRAME_MAX_CHORDS);
}

/**
 * The keydown to replay for a key a document passed on, or nothing. The
 * document can claim any key, so the command the app would run for it now
 * must be one a page may press.
 */
export function replayableKey(registry: ExtensionRegistry, key: FrameKeyDown): KeyboardEvent | undefined {
  if (!key.metaKey && !key.ctrlKey) return undefined;
  const event = new KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true });
  const match = registry.matchKeybinding(event);
  return match && passable(match.command) ? event : undefined;
}

export type FrameZoomStep = "in" | "out" | "reset";
export const FRAME_ZOOM_MIN = 0.5;
export const FRAME_ZOOM_MAX = 2;

// Not bindings: the app menu owns these chords for the workbench's own zoom, which a full-screen frame takes over while it is open.
const ZOOM_KEYS: ReadonlyArray<readonly [key: string, shift: boolean, step: FrameZoomStep]> = [
  ["=", false, "in"], ["+", false, "in"], ["+", true, "in"], ["-", false, "out"], ["0", false, "reset"],
];

/** The chords a full-screen frame asks its document to pass on, so zoom works once a click gave the document the keyboard. */
export function zoomChords(mac = isMacPlatform()): FrameChord[] {
  return ZOOM_KEYS.map(([key, shiftKey]) => ({ key, metaKey: mac, ctrlKey: !mac, shiftKey, altKey: false }));
}

/** The zoom a keydown asks for: ⌘/Ctrl with +, =, - or 0. */
export function zoomStepOf(key: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">, mac = isMacPlatform()): FrameZoomStep | undefined {
  const mod = mac ? key.metaKey && !key.ctrlKey : key.ctrlKey && !key.metaKey;
  if (!mod || key.altKey) return undefined;
  return ZOOM_KEYS.find(([name, shift]) => name === key.key && shift === key.shiftKey)?.[2];
}

/** The next zoom level, in quarters between 50 % and 200 %. */
export function nextZoom(zoom: number, step: FrameZoomStep): number {
  if (step === "reset") return 1;
  return Math.min(FRAME_ZOOM_MAX, Math.max(FRAME_ZOOM_MIN, zoom + (step === "in" ? 0.25 : -0.25)));
}
