/** Rectangles in the workbench page's CSS pixels. */
export interface Box { x: number; y: number; width: number; height: number }
export interface Size { width: number; height: number }

/** What the window half answers `screenshot` with: a picture, or why there is none. */
export type WindowScreenshot =
  | { available: false; reason: string }
  | {
    available: true;
    image: { data: string; mimeType: "image/png"; width: number; height: number };
    /** Present when a package was asked for: whether any of its parts are on screen, and their part names. */
    extension?: { id: string; found: boolean; parts: string[] };
    cropped: boolean;
  };

/** Breathing room around a package's regions, so the picture shows what they sit next to. */
export const DEFAULT_MARGIN = 48;
const MAX_MARGIN = 400;

const visible = (box: Box, viewport: Size): boolean =>
  box.width > 0 && box.height > 0 && box.x < viewport.width && box.y < viewport.height && box.x + box.width > 0 && box.y + box.height > 0;

/** The area around every region that is on screen, clamped to the page; undefined when none is. */
export function cropAround(boxes: readonly Box[], viewport: Size, margin = DEFAULT_MARGIN): Box | undefined {
  const shown = boxes.filter((box) => visible(box, viewport));
  if (shown.length === 0) return undefined;
  const around = Math.min(MAX_MARGIN, Math.max(0, Number.isFinite(margin) ? margin : DEFAULT_MARGIN));
  const left = Math.max(0, Math.floor(Math.min(...shown.map((box) => box.x)) - around));
  const top = Math.max(0, Math.floor(Math.min(...shown.map((box) => box.y)) - around));
  const right = Math.min(viewport.width, Math.ceil(Math.max(...shown.map((box) => box.x + box.width)) + around));
  const bottom = Math.min(viewport.height, Math.ceil(Math.max(...shown.map((box) => box.y + box.height)) + around));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** `box` (CSS pixels of a `viewport`) in the pixels of an `image` of that whole page, kept inside it. */
export function toImagePixels(box: Box, viewport: Size, image: Size): Box {
  const scale = viewport.width > 0 ? image.width / viewport.width : 1;
  const x = Math.min(image.width - 1, Math.max(0, Math.round(box.x * scale)));
  const y = Math.min(image.height - 1, Math.max(0, Math.round(box.y * scale)));
  return {
    x,
    y,
    width: Math.max(1, Math.min(image.width - x, Math.round(box.width * scale))),
    height: Math.max(1, Math.min(image.height - y, Math.round(box.height * scale))),
  };
}
