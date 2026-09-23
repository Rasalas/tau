import type { QuitConfirmation, QuitShortcutMode } from "../shared/window-shell.js";

/** How long ⌘Q has to stay down in `hold` mode. */
export const QUIT_HOLD_MS = 1_000;
/** Two presses this close together quit in every mode. */
export const QUIT_DOUBLE_PRESS_MS = 500;
/**
 * A hold is proven by the key's auto-repeat, never by a missing key-up: macOS
 * drops the letter's key-up while ⌘ is down. After the hold, quitting waits for
 * the release or this long without a repeat, so the repeats do not land in the
 * app that comes forward next.
 */
export const QUIT_RELEASE_QUIET_MS = 600;

/** The part of Electron's `before-input-event` input this reads. */
export interface QuitKeyInput {
  type: string;
  key: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
  isAutoRepeat: boolean;
}

export interface QuitShortcutPorts {
  platform: string;
  /** Read on every press, so a changed setting applies at once. */
  mode(): QuitConfirmation;
  /** The hint in the page: down while the chord waits for a hold or a second press, up once it is gone. */
  hint(event: { state: "down"; mode: QuitShortcutMode } | { state: "up" }): void;
  /** Makes the window look gone while the held key is released; optional. */
  conceal?(): void;
  quit(): void;
  now?(): number;
  schedule?(run: () => void, ms: number): () => void;
}

const defaultSchedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/**
 * The quit chord as a hold or a double press. It runs in `before-input-event`,
 * before the menu's accelerator, and calls `preventDefault` on every event it
 * takes; Quit from the menu itself is never intercepted.
 */
export function createQuitShortcut(ports: QuitShortcutPorts): (event: { preventDefault(): void }, input: QuitKeyInput) => void {
  const now = ports.now ?? Date.now;
  const schedule = ports.schedule ?? defaultSchedule;
  const modifier = ports.platform === "darwin" ? "meta" : "control";
  let lastPress = 0;
  let heldSince = 0;
  let holding: QuitShortcutMode | undefined;
  let hinted = false;
  let quitting = false;
  let cancelTimer: (() => void) | undefined;

  const later = (run: () => void, ms: number) => {
    cancelTimer?.();
    cancelTimer = schedule(() => { cancelTimer = undefined; run(); }, ms);
  };
  const hideHint = () => {
    holding = undefined;
    cancelTimer?.();
    cancelTimer = undefined;
    if (!hinted) return;
    hinted = false;
    ports.hint({ state: "up" });
  };
  const quit = () => {
    hideHint();
    lastPress = 0;
    quitting = false;
    ports.quit();
  };

  return (event, input) => {
    const key = input.key.toLowerCase();
    if (input.type === "keyUp") {
      if (key !== "q" && key !== modifier) return;
      if (quitting) quit();
      else if (holding === "hold") hideHint();
      return;
    }
    if (input.type !== "keyDown") return;
    const chord = key === "q" && (modifier === "meta" ? input.meta && !input.control : input.control && !input.meta) && !input.alt && !input.shift;
    if (quitting) {
      event.preventDefault();
      if (key === "q") later(quit, QUIT_RELEASE_QUIET_MS);
      return;
    }
    if (!chord) {
      // Pressing the modifier again is the start of a second press.
      if (key === modifier || input.isAutoRepeat) return;
      lastPress = 0;
      hideHint();
      return;
    }
    event.preventDefault();
    if (input.isAutoRepeat) {
      if (holding === "hold" && now() - heldSince >= QUIT_HOLD_MS) {
        quitting = true;
        ports.conceal?.();
        later(quit, QUIT_RELEASE_QUIET_MS);
      }
      return;
    }
    const at = now();
    const mode = ports.mode();
    if (mode === "off" || (lastPress !== 0 && at - lastPress <= QUIT_DOUBLE_PRESS_MS)) {
      quit();
      return;
    }
    lastPress = at;
    heldSince = at;
    holding = mode;
    hinted = true;
    ports.hint({ state: "down", mode });
    // Without repeats the key is up (or repeat is off); either way the hint goes.
    later(hideHint, mode === "hold" ? QUIT_HOLD_MS + QUIT_RELEASE_QUIET_MS : QUIT_DOUBLE_PRESS_MS);
  };
}
