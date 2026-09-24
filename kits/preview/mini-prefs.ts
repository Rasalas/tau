import { DEFAULT_MINI_PREFS, type PreviewMiniCorner, type PreviewMiniPrefs } from "./protocol.js";

export const MINI_WIDTH_RANGE = { min: 160, max: 560 } as const;
const CORNERS: readonly PreviewMiniCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];
/** Where a device keeps its floating preview's corner and width. */
export const DEVICE_MINI_PREFS_KEY = "tau.preview.mini";

export function readMiniPrefs(value: unknown, base: PreviewMiniPrefs = DEFAULT_MINI_PREFS): PreviewMiniPrefs {
  const fields = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const corner = CORNERS.find((candidate) => candidate === fields.corner) ?? base.corner;
  const width = typeof fields.width === "number" && Number.isFinite(fields.width)
    ? Math.round(Math.min(MINI_WIDTH_RANGE.max, Math.max(MINI_WIDTH_RANGE.min, fields.width)))
    : base.width;
  return { corner, width };
}

interface Storage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** This device's corner and width; a device that never moved the player starts where the host's state says. */
export function loadDeviceMiniPrefs(storage: Storage | undefined, fallback: PreviewMiniPrefs): PreviewMiniPrefs {
  let stored: string | null = null;
  try {
    stored = storage?.get(DEVICE_MINI_PREFS_KEY) ?? null;
  } catch {
    stored = null;
  }
  if (!stored) return fallback;
  try {
    return readMiniPrefs(JSON.parse(stored), fallback);
  } catch {
    return fallback;
  }
}

export function saveDeviceMiniPrefs(storage: Storage | undefined, prefs: PreviewMiniPrefs): void {
  try {
    storage?.set(DEVICE_MINI_PREFS_KEY, JSON.stringify(readMiniPrefs(prefs)));
  } catch {
    // A full or blocked store keeps the player where it is for this session.
  }
}
