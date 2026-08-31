declare const localTranscriptCursorBrand: unique symbol;
declare const rawBridgeTranscriptCursorBrand: unique symbol;

export type TranscriptCoordinateSpace = "local" | "bridge";

/** The branded value carried by a cursor over local/normalized records. */
export type LocalTranscriptCursorValue = string & { readonly [localTranscriptCursorBrand]: true };

/** Opaque branded value carried by a cursor returned by the Pi bridge. */
export type RawBridgeTranscriptCursorValue = string & { readonly [rawBridgeTranscriptCursorBrand]: true };

/** Cursor over the host's normalized/local transcript records. */
export interface LocalTranscriptCursor {
  readonly kind: "local";
  readonly value: LocalTranscriptCursorValue;
}

/** Cursor whose coordinate belongs to the Pi bridge's raw branch. */
export interface RawBridgeTranscriptCursor {
  readonly kind: "bridge";
  readonly value: RawBridgeTranscriptCursorValue;
}

export type TranscriptCursor = LocalTranscriptCursor | RawBridgeTranscriptCursor;

function parseDecimalCursor(value: unknown, maximum?: number): string {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) throw new Error("Invalid transcript cursor");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || (maximum !== undefined && number > maximum)) {
    throw new Error("Invalid transcript cursor");
  }
  return value;
}

export function parseLocalTranscriptCursor(value: unknown, maximum?: number): LocalTranscriptCursor {
  return { kind: "local", value: parseDecimalCursor(value, maximum) as LocalTranscriptCursorValue };
}

export function parseRawBridgeTranscriptCursor(value: unknown, maximum?: number): RawBridgeTranscriptCursor {
  return { kind: "bridge", value: parseDecimalCursor(value, maximum) as RawBridgeTranscriptCursorValue };
}

export function localTranscriptCursorAt(index: number): LocalTranscriptCursor {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Invalid transcript cursor");
  return { kind: "local", value: String(index) as LocalTranscriptCursorValue };
}

export function rawBridgeTranscriptCursorAt(index: number): RawBridgeTranscriptCursor {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Invalid transcript cursor");
  return { kind: "bridge", value: String(index) as RawBridgeTranscriptCursorValue };
}

/** Parse either a typed cursor or a legacy v1 string at a contract boundary. */
export function parseTranscriptCursor(
  value: unknown,
  maximum?: number,
  coordinateSpace?: TranscriptCoordinateSpace,
): TranscriptCursor {
  if (typeof value === "string") {
    return coordinateSpace === "bridge"
      ? parseRawBridgeTranscriptCursor(value, maximum)
      : parseLocalTranscriptCursor(value, maximum);
  }
  if (value !== null && typeof value === "object") {
    const cursor = value as { kind?: unknown; value?: unknown };
    if (cursor.kind === "local") {
      if (coordinateSpace === "bridge") throw new Error("Transcript cursor coordinate space does not match its origin");
      return parseLocalTranscriptCursor(cursor.value, maximum);
    }
    if (cursor.kind === "bridge") {
      if (coordinateSpace === "local") throw new Error("Transcript cursor coordinate space does not match its origin");
      return parseRawBridgeTranscriptCursor(cursor.value, maximum);
    }
  }
  throw new Error("Invalid transcript cursor");
}

/** Read a cursor value only at a boundary that explicitly handles its origin. */
export function transcriptCursorValue(cursor: TranscriptCursor | string): string {
  return typeof cursor === "string" ? cursor : cursor.value;
}

/** Validate and read a numeric coordinate without changing the cursor's origin. */
export function transcriptCursorIndex(
  cursor: TranscriptCursor | string,
  maximum?: number,
  coordinateSpace?: TranscriptCoordinateSpace,
): number {
  const parsed = parseTranscriptCursor(cursor, maximum, coordinateSpace);
  return Number(parsed.value);
}
