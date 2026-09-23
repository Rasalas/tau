import type { EvidenceTrigger, ScreenAction } from "./protocol.js";

/** A small grey copy of a kept frame, what the next one is compared with. */
export interface Luma {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** A step of brightness smaller than this is compression noise, not a change. */
const LUMA_STEP = 12;
/** A frame the clock took must change this share of the picture to be kept. */
const PERIODIC_SHARE = 0.002;

export function changedPixels(before: Luma, after: Luma): number {
  if (before.width !== after.width || before.height !== after.height) return Number.POSITIVE_INFINITY;
  let changed = 0;
  for (let index = 0; index < after.pixels.length; index += 1) {
    if (Math.abs((after.pixels[index] ?? 0) - (before.pixels[index] ?? 0)) > LUMA_STEP) changed += 1;
  }
  return changed;
}

/**
 * Whether a new frame shows nothing the last kept one did not. An action or a
 * turn's edge keeps any visible change, the clock only a real one; a frame the
 * agent asked for is always kept.
 */
export function isDuplicate(before: Luma | undefined, after: Luma, trigger: EvidenceTrigger): boolean {
  if (!before || trigger === "agent") return false;
  const changed = changedPixels(before, after);
  if (trigger === "periodic") return changed < Math.max(4, after.pixels.length * PERIODIC_SHARE);
  return changed === 0;
}

const tool = (name: string): string => name.replace(/^.*?(?:__|\.)(?=preview_|computer_use_)/u, "");

/** The Preview tool a call ran, whatever prefix its runtime put in front (`mcp__tau__preview_click`). */
export function previewToolName(name: string): string | undefined {
  const bare = tool(name);
  return bare.startsWith("preview_") ? bare : undefined;
}

export function isScreenTool(name: string): boolean {
  return tool(name).startsWith("computer_use_");
}

const quoted = (text: string, max = 48): string => `“${text.length > max ? `${text.slice(0, max - 1)}…` : text}”`;
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * One line saying what an agent's Preview call did. Typed text is never
 * repeated: it may be a secret the page masks.
 */
export function previewCaption(name: string, args: Record<string, unknown>): string {
  switch (previewToolName(name)) {
    case "preview_open": return text(args.url) ? `Opened ${text(args.url)}` : "Opened a page";
    case "preview_navigate": {
      if (text(args.url)) return `Went to ${text(args.url)}`;
      if (args.action === "back") return "Went back";
      if (args.action === "forward") return "Went forward";
      return "Reloaded the page";
    }
    case "preview_click": return `Clicked ${text(args.text) ? quoted(text(args.text)!) : text(args.selector) ?? text(args.ref) ?? "an element"}`;
    case "preview_type": return `Typed ${String(typeof args.text === "string" ? args.text.length : 0)} characters${args.submit === true ? " and submitted" : ""}`;
    case "preview_press": return text(args.key) ? `Pressed ${text(args.key)}` : "Pressed a key";
    case "preview_scroll": return "Scrolled";
    case "preview_wait_for": return text(args.text) ? `Waited for ${quoted(text(args.text)!)}` : "Waited for the page";
    case "preview_evaluate": return "Ran a script in the page";
    default: return "Looked at the page";
  }
}

const KEY_GLYPHS: Record<string, string> = { cmd: "⌘", command: "⌘", ctrl: "⌃", control: "⌃", alt: "⌥", option: "⌥", shift: "⇧" };

/** One line saying what an input to the driven window did. */
export function screenCaption(action: ScreenAction | undefined, app: string | undefined): string {
  switch (action?.kind) {
    case "click": return "Clicked";
    case "double-click": return "Double-clicked";
    case "right-click": return "Right-clicked";
    case "drag": return "Dragged";
    case "type": return `Typed ${String(action.text?.length ?? 0)} characters`;
    case "key": return `Pressed ${(action.keys ?? []).map((key) => KEY_GLYPHS[key.toLowerCase()] ?? (key.length === 1 ? key.toUpperCase() : key)).join("")}`;
    case "scroll": return action.direction ? `Scrolled ${action.direction}` : "Scrolled";
    default: return app ? `Looked at ${app}` : "Looked at the window";
  }
}
