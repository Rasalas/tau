/** The next enabled index from `from` in `step` direction, wrapping; -1 when every entry is disabled. */
export function stepEnabled(disabled: readonly boolean[], from: number, step: 1 | -1): number {
  const count = disabled.length;
  for (let offset = 1; offset <= count; offset += 1) {
    const index = (((from + step * offset) % count) + count) % count;
    if (!disabled[index]) return index;
  }
  return -1;
}

export const firstEnabled = (disabled: readonly boolean[]): number => stepEnabled(disabled, -1, 1);
export const lastEnabled = (disabled: readonly boolean[]): number => stepEnabled(disabled, disabled.length, -1);

export interface TypeaheadState {
  buffer: string;
  at: number;
}

export const TYPEAHEAD_RESET_MS = 500;

/**
 * Typing jumps to the entry whose label starts with what was typed within the
 * last half second. Repeating one letter walks through the entries starting
 * with it, as native menus do.
 */
export function typeahead(
  labels: readonly string[],
  disabled: readonly boolean[],
  current: number,
  previous: TypeaheadState | undefined,
  key: string,
  now: number,
): { index: number; state: TypeaheadState } {
  const char = key.toLowerCase();
  const continuing = previous && now - previous.at < TYPEAHEAD_RESET_MS;
  const buffer = continuing ? previous.buffer + char : char;
  const state = { buffer, at: now };
  const repeated = [...buffer].every((letter) => letter === char);
  const needle = repeated ? char : buffer;
  // A longer word may still match the entry already focused; one letter moves on.
  const start = repeated ? current + 1 : Math.max(current, 0);
  const count = labels.length;
  for (let offset = 0; offset < count; offset += 1) {
    const index = (start + offset) % count;
    if (!disabled[index] && labels[index]!.trim().toLowerCase().startsWith(needle)) return { index, state };
  }
  return { index: current, state };
}

/** A key that types a character, not a chord or a navigation key. */
export const isTypeaheadKey = (event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean =>
  event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey;
