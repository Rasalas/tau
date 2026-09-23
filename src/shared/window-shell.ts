/**
 * What the window's own process and its page say to each other about the app
 * around the workbench: the app menu, the quit shortcut, a quit waiting for an
 * answer, the release notes of the version that just started. The process
 * speaks through a `window-shell` push on its own Electron transport; the page
 * answers through the client-side `window-action` method. A browser tab has
 * neither side.
 */

/** Menu items the page carries out, because only the page knows how. */
export type WindowMenuAction = "open-settings" | "open-about" | "paste-as-text";

/**
 * The chords the app menu takes, in the workbench's spelling. Settings is the
 * one the page binds too, to the same command; no other binding may take one
 * (`kits/kit-lifecycle.test.tsx`).
 */
export const APP_MENU_CHORDS = {
  settings: "mod+,",
  pasteAsText: "mod+shift+v",
  actualSize: "mod+0",
  zoomIn: "mod+=",
  zoomInPlus: "mod++",
  zoomOut: "mod+-",
  quit: "mod+q",
} as const;

/** How ⌘Q (Ctrl+Q) quits: held for a moment, pressed twice, or at once. */
export type QuitShortcutMode = "hold" | "double-press";
export type QuitConfirmation = QuitShortcutMode | "off";
export const QUIT_CONFIRMATIONS: readonly QuitConfirmation[] = ["hold", "double-press", "off"];
export const DEFAULT_QUIT_CONFIRMATION: QuitConfirmation = "hold";

export function isQuitConfirmation(value: unknown): value is QuitConfirmation {
  return value === "hold" || value === "double-press" || value === "off";
}

export type WindowShellEvent =
  | { kind: "menu"; action: WindowMenuAction }
  /** The quit chord is down and waits for a hold or a second press; `up` hides the hint. */
  | { kind: "quit-shortcut"; state: "down"; mode: QuitShortcutMode }
  | { kind: "quit-shortcut"; state: "up" }
  /** The app is about to quit; the page answers with `answer-quit`. */
  | { kind: "quit-requested"; requestId: string };

/** The page's answer to a quit: go ahead, stay, or wait while it asks the user. */
export type QuitAnswer = "quit" | "stay" | "asking";

/** A release's notes as a short list, the way the window shows them once after an update. */
export interface ReleaseNotes {
  version: string;
  items: string[];
  /** How many items the release lists; more than `items` when the list was cut. */
  totalItems: number;
  /** The release page, for the rest. */
  url?: string;
}

/** What the page asks when it loads: a downloaded update and notes it has not shown yet. */
export interface WindowShellStatus {
  updateReady?: string;
  releaseNotes?: ReleaseNotes;
}

export type WindowAction =
  /** Pastes the clipboard's text into whatever has focus, without its formatting. */
  | { kind: "paste-as-text" }
  | { kind: "answer-quit"; requestId: string; answer: QuitAnswer }
  | { kind: "status" }
  /** The notes of `version` were shown; they are not offered again. */
  | { kind: "release-notes-seen"; version: string }
  | { kind: "check-for-updates" };

const QUIT_ANSWERS = new Set<string>(["quit", "stay", "asking"]);

/** Validates a `window-action` parameter; the page is not trusted with anything else. */
export function decodeWindowAction(method: string, value: unknown): WindowAction {
  const item = value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
  const fail = (): never => { throw new Error(`${method}: not a window action`); };
  if (!item || typeof item.kind !== "string") return fail();
  switch (item.kind) {
    case "paste-as-text":
    case "status":
    case "check-for-updates":
      return { kind: item.kind };
    case "answer-quit":
      if (typeof item.requestId !== "string" || !item.requestId || typeof item.answer !== "string" || !QUIT_ANSWERS.has(item.answer)) return fail();
      return { kind: "answer-quit", requestId: item.requestId, answer: item.answer as QuitAnswer };
    case "release-notes-seen":
      if (typeof item.version !== "string" || !item.version) return fail();
      return { kind: "release-notes-seen", version: item.version };
    default:
      return fail();
  }
}
