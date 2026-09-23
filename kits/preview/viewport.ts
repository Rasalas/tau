import type { PreviewAppearance, PreviewChord, PreviewDefaults, PreviewRecordingOptions, PreviewViewport } from "./protocol.js";

/** Chrome's zoom ladder, which T3 Code's preview steps through too. */
export const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5] as const;

export const FRAME_RATES = [15, 30, 60] as const;

export interface ViewportPreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

/** A few common sizes in CSS pixels, portrait for devices; a smaller set than DevTools'. */
export const VIEWPORT_PRESETS: readonly ViewportPreset[] = [
  { id: "iphone-se", label: "iPhone SE", width: 375, height: 667 },
  { id: "iphone-12-pro", label: "iPhone 12 Pro", width: 390, height: 844 },
  { id: "pixel-7", label: "Pixel 7", width: 412, height: 915 },
  { id: "ipad-air", label: "iPad Air", width: 820, height: 1180 },
  { id: "laptop", label: "Laptop", width: 1280, height: 800 },
  { id: "desktop", label: "Desktop", width: 1440, height: 900 },
];

export const FILL_VIEWPORT: PreviewViewport = { mode: "fill" };

export const DEFAULT_RECORDING_OPTIONS: PreviewRecordingOptions = { frameRate: 30, showKeys: false, showClicks: false };

export const DEFAULT_PREVIEW_DEFAULTS: PreviewDefaults = {
  viewport: FILL_VIEWPORT,
  zoom: 1,
  appearance: "system",
  recording: DEFAULT_RECORDING_OPTIONS,
};

const MIN_SIDE = 200;
const MAX_SIDE = 4_000;

/** The ladder step `direction` from `current`; a factor between two steps goes to the next one. */
export function stepZoom(current: number, direction: "in" | "out" | "reset"): number {
  if (direction === "reset") return 1;
  if (direction === "in") return ZOOM_LEVELS.find((level) => level > current + 0.001) ?? ZOOM_LEVELS.at(-1)!;
  return [...ZOOM_LEVELS].reverse().find((level) => level < current - 0.001) ?? ZOOM_LEVELS[0];
}

export function readZoom(value: unknown): number | undefined {
  const factor = typeof value === "string" ? Number(value) : value;
  if (typeof factor !== "number" || !Number.isFinite(factor)) return undefined;
  return Math.min(ZOOM_LEVELS.at(-1)!, Math.max(ZOOM_LEVELS[0], factor));
}

export function readAppearance(value: unknown): PreviewAppearance | undefined {
  return value === "system" || value === "light" || value === "dark" ? value : undefined;
}

export function readFrameRate(value: unknown): number | undefined {
  const rate = typeof value === "string" ? Number(value) : value;
  return FRAME_RATES.find((candidate) => candidate === rate);
}

/**
 * A viewport from anything: `fill`, a preset id (landscape swaps its sides),
 * or a width and height in CSS pixels within 200–4000.
 */
export function readViewport(value: unknown): PreviewViewport | undefined {
  if (value === "fill") return FILL_VIEWPORT;
  if (typeof value === "string") {
    const preset = VIEWPORT_PRESETS.find((candidate) => candidate.id === value);
    if (preset) return { mode: "fixed", width: preset.width, height: preset.height, preset: preset.id };
    const size = /^(\d+)\s*[x×]\s*(\d+)$/u.exec(value.trim());
    return size ? readViewport({ mode: "fixed", width: Number(size[1]), height: Number(size[2]) }) : undefined;
  }
  const fields = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
  if (!fields) return undefined;
  if (fields.mode === "fill") return FILL_VIEWPORT;
  if (fields.mode === "preset" || (fields.mode === "fixed" && typeof fields.preset === "string" && fields.width === undefined)) {
    const preset = VIEWPORT_PRESETS.find((candidate) => candidate.id === fields.preset);
    if (!preset) return undefined;
    const landscape = fields.orientation === "landscape";
    return { mode: "fixed", width: landscape ? preset.height : preset.width, height: landscape ? preset.width : preset.height, preset: preset.id };
  }
  if (fields.mode !== "fixed" && fields.mode !== "freeform") return undefined;
  const side = (key: string) => {
    const number = fields[key];
    return typeof number === "number" && Number.isFinite(number) ? Math.round(number) : Number.NaN;
  };
  const width = side("width");
  const height = side("height");
  if (!(width >= MIN_SIDE && width <= MAX_SIDE && height >= MIN_SIDE && height <= MAX_SIDE)) return undefined;
  const preset = typeof fields.preset === "string" ? VIEWPORT_PRESETS.find((candidate) => candidate.id === fields.preset) : undefined;
  return { mode: "fixed", width, height, ...(preset ? { preset: preset.id } : {}) };
}

export function viewportLabel(viewport: PreviewViewport): string {
  if (viewport.mode === "fill") return "Fill the panel";
  const preset = VIEWPORT_PRESETS.find((candidate) => candidate.id === viewport.preset);
  const size = `${viewport.width}×${viewport.height}`;
  return preset ? `${preset.label} · ${size}` : size;
}

export function readDefaults(value: unknown): PreviewDefaults {
  const fields = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const recording = fields.recording && typeof fields.recording === "object" ? fields.recording as Record<string, unknown> : {};
  return {
    viewport: readViewport(fields.viewport) ?? DEFAULT_PREVIEW_DEFAULTS.viewport,
    zoom: readZoom(fields.zoom) ?? DEFAULT_PREVIEW_DEFAULTS.zoom,
    appearance: readAppearance(fields.appearance) ?? DEFAULT_PREVIEW_DEFAULTS.appearance,
    recording: {
      frameRate: readFrameRate(recording.frameRate) ?? DEFAULT_RECORDING_OPTIONS.frameRate,
      showKeys: recording.showKeys === true,
      showClicks: recording.showClicks === true,
    },
  };
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the view goes inside the panel's rectangle and at what page zoom. A
 * fixed viewport keeps its CSS size exactly: the view shrinks to fit the panel
 * (never past the user's zoom) and the page zoom shrinks with it, so media
 * queries see the width asked for. Rectangles are in window pixels.
 */
export function fitViewport(panel: Rect, viewport: PreviewViewport, zoom: number): { rect: Rect; zoom: number } {
  if (viewport.mode === "fill" || panel.width <= 0 || panel.height <= 0) return { rect: panel, zoom };
  const scale = Math.max(0.1, Math.min(zoom, panel.width / viewport.width, panel.height / viewport.height));
  const width = Math.min(panel.width, Math.round(viewport.width * scale));
  const height = Math.min(panel.height, Math.round(viewport.height * scale));
  return {
    rect: { x: panel.x + Math.floor((panel.width - width) / 2), y: panel.y, width, height },
    zoom: scale,
  };
}

/** The fields of Electron's `before-input-event` input that name a chord. */
export interface ChordInput {
  type: string;
  key: string;
  meta: boolean;
  control: boolean;
  shift: boolean;
  alt: boolean;
}

/**
 * The chord the page's own keys ask for: ⌘R reloads the page (⇧ skips the
 * cache), ⌘+/⌘=, ⌘− and ⌘0 zoom it. On macOS ⌘, elsewhere Ctrl.
 */
export function previewChord(input: ChordInput, platform: NodeJS.Platform | string): PreviewChord | undefined {
  if (input.type !== "keyDown" || input.alt) return undefined;
  const mod = platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
  if (!mod) return undefined;
  const key = input.key.toLowerCase();
  if (key === "r") return input.shift ? "hard-reload" : "reload";
  if (input.shift && key !== "+") return undefined;
  if (key === "=" || key === "+") return "zoom-in";
  if (key === "-") return "zoom-out";
  if (key === "0") return "zoom-reset";
  return undefined;
}
