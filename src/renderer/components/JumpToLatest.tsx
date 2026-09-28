import { useSyncExternalStore } from "react";
import { ArrowDown } from "lucide-react";
import { tooltipProps } from "./ui/Tooltip";

/**
 * Carries the transcript's "away from the latest message" to the controls row
 * over the composer, so neither re-renders the other.
 */
export class JumpToLatestStore {
  private jump: (() => void) | undefined;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly available = (): boolean => this.jump !== undefined;

  /** The transcript offers its jump while the reader is away from the tail, and `undefined` otherwise. */
  set(jump: (() => void) | undefined): void {
    if (this.jump === jump) return;
    this.jump = jump;
    this.listeners.forEach((listener) => listener());
  }

  run(): void {
    this.jump?.();
  }
}

/**
 * A round arrow beside the row's pills, or alone over the transcript's bottom edge; nothing at the latest message.
 * It floats in a slot that takes no room, so showing it never moves the transcript or the row.
 */
export function JumpToLatestButton({ store, onKeyboardJump }: {
  store: JumpToLatestStore;
  /** The button leaves once the tail is reached, so a keyboard user needs a place for the focus. */
  onKeyboardJump?: () => void;
}) {
  const available = useSyncExternalStore(store.subscribe, store.available, store.available);
  if (!available) return null;
  return (
    <span className="jump-to-latest-float">
      <button
        type="button"
        className="control-pill icon-only jump-to-latest"
        aria-label="Jump to latest"
        {...tooltipProps("Jump to latest", { side: "top" })}
        // A click leaves the focus where it was, usually in the composer.
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => {
          store.run();
          if (event.detail === 0) onKeyboardJump?.();
        }}
      >
        <ArrowDown aria-hidden="true" />
      </button>
    </span>
  );
}
