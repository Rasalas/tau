import type { PreviewAnnotationItem, PreviewAnnotationResult, PreviewBox, PreviewPickedElement } from "./page-overlay.js";

/**
 * What the page hands back is untrusted: a page can shadow the globals the
 * pick relies on. These readers take a value apart field by field and answer
 * `undefined` for anything that is not the expected shape.
 */
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const text = (value: unknown, limit: number): string | undefined =>
  typeof value === "string" ? value.slice(0, limit) : undefined;

function readBox(value: unknown): PreviewBox | undefined {
  const box = record(value);
  if (!box || !finite(box.x) || !finite(box.y) || !finite(box.width) || !finite(box.height)) return undefined;
  return { x: box.x, y: box.y, width: Math.max(0, box.width), height: Math.max(0, box.height) };
}

function readViewport(value: unknown): { width: number; height: number } | undefined {
  const viewport = record(value);
  if (!viewport || !finite(viewport.width) || !finite(viewport.height)) return undefined;
  return { width: Math.max(0, viewport.width), height: Math.max(0, viewport.height) };
}

export function readPickedElement(value: unknown): PreviewPickedElement | undefined {
  const element = record(value);
  if (!element) return undefined;
  const url = text(element.url, 2_000);
  const title = text(element.title, 300);
  const selector = text(element.selector, 1_000);
  const tag = text(element.tag, 60);
  const body = text(element.text, 2_000);
  const html = text(element.html, 4_000);
  const rect = readBox(element.rect);
  const viewport = readViewport(element.viewport);
  if (url === undefined || title === undefined || !selector || !tag || body === undefined || html === undefined || !rect || !viewport) return undefined;
  return { url, title, selector, tag, text: body, rect, html, viewport };
}

const KINDS = new Set(["rect", "arrow", "note"]);

export function readAnnotationResult(value: unknown): PreviewAnnotationResult | undefined {
  const result = record(value);
  if (!result || !Array.isArray(result.items)) return undefined;
  const url = text(result.url, 2_000);
  const title = text(result.title, 300);
  const viewport = readViewport(result.viewport);
  if (url === undefined || title === undefined || !viewport) return undefined;
  const items: PreviewAnnotationItem[] = [];
  for (const raw of result.items.slice(0, 100)) {
    const item = record(raw);
    if (!item || !finite(item.n) || !finite(item.x) || !finite(item.y) || !KINDS.has(item.kind as string)) return undefined;
    const note = text(item.note, 1_000);
    if (note === undefined) return undefined;
    const read: PreviewAnnotationItem = { n: item.n, kind: item.kind as PreviewAnnotationItem["kind"], x: item.x, y: item.y, note };
    for (const key of ["width", "height", "toX", "toY"] as const) if (finite(item[key])) read[key] = item[key] as number;
    items.push(read);
  }
  return { url, title, viewport, items };
}

/**
 * The part of the viewport a picked element's image is cut from: its box with
 * a margin, kept inside the viewport. `undefined` when nothing of it is visible.
 */
export function pickCrop(rect: PreviewBox, viewport: { width: number; height: number }, margin = 8): PreviewBox | undefined {
  const left = Math.max(0, Math.floor(rect.x - margin));
  const top = Math.max(0, Math.floor(rect.y - margin));
  const right = Math.min(viewport.width, Math.ceil(rect.x + rect.width + margin));
  const bottom = Math.min(viewport.height, Math.ceil(rect.y + rect.height + margin));
  if (right - left < 1 || bottom - top < 1) return undefined;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** `localhost:8000/docs` rather than the whole URL, for a chip's label. */
export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return parsed.pathname.split("/").pop() || parsed.pathname;
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.host}${path}`;
  } catch {
    return url;
  }
}

/** The chip for a picked element: a label and the excerpt the agent reads. */
export function pickedElementExcerpt(element: PreviewPickedElement, withImage: boolean): { label: string; source: string; text: string } {
  const lines = [
    `selector: ${element.selector}`,
    `tag: <${element.tag}>`,
    ...(element.text ? [`text: ${JSON.stringify(element.text)}`] : []),
    `box: x=${element.rect.x} y=${element.rect.y} ${element.rect.width}×${element.rect.height} (CSS px, viewport ${element.viewport.width}×${element.viewport.height})`,
    "html:",
    element.html,
  ];
  return {
    label: `<${element.tag}> · ${shortUrl(element.url)}`,
    source: `the Preview, an element the user picked on ${element.url}${element.title ? ` ("${element.title}")` : ""}${withImage ? "; the attached image shows it" : ""}`,
    text: lines.join("\n"),
  };
}

function describeItem(item: PreviewAnnotationItem): string {
  const note = item.note ? `: ${item.note}` : " (no note)";
  switch (item.kind) {
    case "rect": return `${item.n}. rectangle at x=${item.x} y=${item.y}, ${item.width ?? 0}×${item.height ?? 0}${note}`;
    case "arrow": return `${item.n}. arrow from (${item.x}, ${item.y}) to (${item.toX ?? item.x}, ${item.toY ?? item.y})${note}`;
    case "note": return `${item.n}. note at (${item.x}, ${item.y})${note}`;
  }
}

/** The chip for a set of annotations: the numbered notes, which the attached image shows by number. */
export function annotationExcerpt(result: PreviewAnnotationResult, withImage: boolean): { label: string; source: string; text: string } {
  const count = result.items.length;
  return {
    label: `${count} annotation${count === 1 ? "" : "s"} · ${shortUrl(result.url)}`,
    source: `the Preview, annotations the user drew on ${result.url}${result.title ? ` ("${result.title}")` : ""}${withImage ? "; the attached image shows the page with them, numbered" : ""}`,
    text: [
      `viewport: ${result.viewport.width}×${result.viewport.height} CSS px`,
      ...(count > 0 ? result.items.map(describeItem) : ["(the user drew nothing)"]),
    ].join("\n"),
  };
}
