declare const hostTranscriptCursorBrand: unique symbol;

/**
 * Cursor owned by the desktop host.
 *
 * The renderer may retain and return this value, but it must not inspect or
 * derive a position from it. Host adapters decide how their runtime cursor is
 * encoded and translated at the host seam.
 */
export type HostTranscriptCursor = string & { readonly [hostTranscriptCursorBrand]: true };

/** Brand a value received from a host adapter without assigning it semantics. */
export function asHostTranscriptCursor(value: string): HostTranscriptCursor {
  if (typeof value !== "string" || value.length === 0) throw new Error("Invalid host transcript cursor");
  return value as HostTranscriptCursor;
}

/** Validate the opaque wire shape without interpreting its coordinate. */
export function isHostTranscriptCursor(value: unknown): value is HostTranscriptCursor {
  return typeof value === "string" && value.length > 0;
}
