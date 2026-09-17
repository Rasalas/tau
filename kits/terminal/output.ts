import type { TerminalDataEvent } from "./protocol.js";

/**
 * What of a pushed chunk a client still has to draw. The host numbers output
 * by byte offset; a client that replayed up to `drawn` skips the overlap when a
 * live push and the replay covered the same bytes, and ignores a chunk it has
 * fully seen.
 */
export function unseenOutput(event: TerminalDataEvent, drawn: number): string {
  if (event.offset <= drawn) return "";
  const start = event.offset - event.data.length;
  return event.data.slice(Math.max(0, drawn - start));
}
