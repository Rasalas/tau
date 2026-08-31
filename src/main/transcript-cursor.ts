import { asHostTranscriptCursor, type HostTranscriptCursor } from "../shared/transcript-cursor.js";

/** Coordinate owned by the host adapter, never by the renderer contract. */
export type HostCursorCoordinate =
  | { kind: "local"; index: number }
  | { kind: "bridge"; value: string };

const HOST_CURSOR_PREFIX = "tau-host-cursor.v1.";

function parseDecimal(value: unknown, maximum?: number): string {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) throw new Error("Invalid transcript cursor");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || (maximum !== undefined && number > maximum)) {
    throw new Error("Invalid transcript cursor");
  }
  return value;
}

export function parseLocalCursor(value: unknown, maximum?: number): number {
  return Number(parseDecimal(value, maximum));
}

export function parseBridgeCursor(value: unknown, maximum?: number): string {
  return parseDecimal(value, maximum);
}

export function rawBridgeCursorAt(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Invalid transcript cursor");
  return String(index);
}

function encodeCoordinate(coordinate: HostCursorCoordinate): HostTranscriptCursor {
  const payload = Buffer.from(JSON.stringify(coordinate), "utf8").toString("base64url");
  return asHostTranscriptCursor(`${HOST_CURSOR_PREFIX}${payload}`);
}

export function hostCursorAtLocalIndex(index: number): HostTranscriptCursor {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("Invalid transcript cursor");
  return encodeCoordinate({ kind: "local", index });
}

export function hostCursorAtBridgeValue(value: unknown): HostTranscriptCursor {
  return encodeCoordinate({ kind: "bridge", value: parseBridgeCursor(value) });
}

function decodeEncodedCursor(value: string): HostCursorCoordinate {
  if (!value.startsWith(HOST_CURSOR_PREFIX)) {
    return { kind: "local", index: parseLocalCursor(value) };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value.slice(HOST_CURSOR_PREFIX.length), "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid host transcript cursor");
  }
  if (!decoded || typeof decoded !== "object") throw new Error("Invalid host transcript cursor");
  const candidate = decoded as { kind?: unknown; index?: unknown; value?: unknown };
  if (candidate.kind === "local") {
    if (typeof candidate.index !== "number" || !Number.isSafeInteger(candidate.index) || candidate.index < 0) {
      throw new Error("Invalid host transcript cursor");
    }
    return { kind: "local", index: candidate.index };
  }
  if (candidate.kind === "bridge") return { kind: "bridge", value: parseBridgeCursor(candidate.value) };
  throw new Error("Invalid host transcript cursor");
}

/** Decode a host cursor at the host seam, accepting pre-opaque v1 values for migration. */
export function decodeHostCursor(value: unknown): HostCursorCoordinate {
  if (typeof value === "string") return decodeEncodedCursor(value);
  if (!value || typeof value !== "object") throw new Error("Invalid host transcript cursor");
  const candidate = value as { kind?: unknown; value?: unknown; index?: unknown };
  if (candidate.kind === "local") {
    return { kind: "local", index: parseLocalCursor(candidate.value ?? candidate.index) };
  }
  if (candidate.kind === "bridge") return { kind: "bridge", value: parseBridgeCursor(candidate.value) };
  throw new Error("Invalid host transcript cursor");
}

export function bridgeCursorValue(value: unknown): string {
  const coordinate = decodeHostCursor(value);
  if (coordinate.kind !== "bridge") throw new Error("A local transcript cursor cannot be sent to the Pi bridge.");
  return coordinate.value;
}
