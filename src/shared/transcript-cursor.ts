declare const localTranscriptCursorBrand: unique symbol;
declare const rawBridgeTranscriptCursorBrand: unique symbol;

/** Cursor over the host's normalized/local transcript records. */
export type LocalTranscriptCursor = string & { readonly [localTranscriptCursorBrand]: true };

/** Opaque raw branch cursor returned by the Pi bridge. */
export type RawBridgeTranscriptCursor = string & { readonly [rawBridgeTranscriptCursorBrand]: true };

function parseDecimalCursor(value: unknown, maximum?: number): string {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) throw new Error("Invalid transcript cursor");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || (maximum !== undefined && number > maximum)) {
    throw new Error("Invalid transcript cursor");
  }
  return value;
}

export function parseLocalTranscriptCursor(value: unknown, maximum?: number): LocalTranscriptCursor {
  return parseDecimalCursor(value, maximum) as LocalTranscriptCursor;
}

export function parseRawBridgeTranscriptCursor(value: unknown): RawBridgeTranscriptCursor {
  return parseDecimalCursor(value) as RawBridgeTranscriptCursor;
}

export function localTranscriptCursorAt(index: number): LocalTranscriptCursor {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Invalid transcript cursor");
  return String(index) as LocalTranscriptCursor;
}

export function transcriptCursorValue(cursor: LocalTranscriptCursor | RawBridgeTranscriptCursor): string {
  return cursor;
}
