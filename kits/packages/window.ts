import { BrowserWindow } from "electron";
import type { WindowExtension, WindowExtensionContext } from "tau/host-extension";
import { cropAround, toImagePixels, type Box, type Size, type WindowScreenshot } from "./screenshot-crop.js";

const DEFAULT_MAX_WIDTH = 1_600;

/** The workbench window of this process: visible or minimized, never a hidden helper page; the focused one first. */
function workbenchWindow(): BrowserWindow | undefined {
  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed() && (window.isVisible() || window.isMinimized()));
  return windows.find((window) => window.isFocused()) ?? windows[0];
}

/** The page's size and the boxes of the parts `data-tau-extension-id` marks as the extension's. */
const regionsScript = (extensionId: string): string => `((id) => {
  const boxes = (element) => {
    const out = [];
    for (const child of element.children) {
      const style = getComputedStyle(child);
      if (style.display === "contents") { out.push(...boxes(child)); continue; }
      if (style.visibility === "hidden") continue;
      const { x, y, width, height } = child.getBoundingClientRect();
      if (width > 0 && height > 0) out.push({ x, y, width, height });
    }
    return out;
  };
  const parts = [];
  for (const element of document.querySelectorAll("[data-tau-extension-id]")) {
    if (element.getAttribute("data-tau-extension-id") === id) parts.push({ part: element.getAttribute("data-tau-part") || "", boxes: boxes(element) });
  }
  return { viewport: { width: window.innerWidth, height: window.innerHeight }, parts };
})(${JSON.stringify(extensionId)})`;

interface RegionReading { viewport: Size; parts: Array<{ part: string; boxes: Box[] }> }

const fields = (input: unknown): Record<string, unknown> => input && typeof input === "object" ? input as Record<string, unknown> : {};

/** One picture of Tau's own window; there is no way to name another window or a screen. */
export async function screenshotWorkbench(window: BrowserWindow | undefined, input: unknown): Promise<WindowScreenshot> {
  if (!window) return { available: false, reason: "Tau has no open window on this machine." };
  if (window.isMinimized()) return { available: false, reason: "Tau's window is minimized; the user has to bring it back first." };
  const { extension, margin, maxWidth } = fields(input);
  const contents = window.webContents;
  const extensionId = typeof extension === "string" && extension.trim() ? extension.trim() : undefined;
  let crop: Box | undefined;
  let parts: string[] = [];
  let viewport: Size | undefined;
  if (extensionId) {
    const reading = await contents.executeJavaScript(regionsScript(extensionId)) as RegionReading;
    viewport = reading.viewport;
    crop = cropAround(reading.parts.flatMap((part) => part.boxes), viewport, typeof margin === "number" ? margin : undefined);
    parts = reading.parts.filter((part) => part.boxes.length > 0).map((part) => part.part);
  }
  const image = await contents.capturePage();
  if (image.isEmpty()) return { available: false, reason: "The window gave no picture; it may be hidden behind another window or still starting." };
  const full = image.getSize();
  const shown = crop && viewport ? image.crop(toImagePixels(crop, viewport, full)) : image;
  const size = shown.getSize();
  const limit = typeof maxWidth === "number" && maxWidth >= 200 ? Math.min(maxWidth, 4_000) : DEFAULT_MAX_WIDTH;
  const scaled = size.width > limit ? shown.resize({ width: limit, height: Math.max(1, Math.round(size.height * (limit / size.width))), quality: "good" }) : shown;
  const final = scaled.getSize();
  return {
    available: true,
    image: { data: scaled.toPNG().toString("base64"), mimeType: "image/png", width: final.width, height: final.height },
    ...(extensionId ? { extension: { id: extensionId, found: crop !== undefined, parts } } : {}),
    cropped: crop !== undefined,
  };
}

/** Packages Kit's half in the window's process: it can see the workbench window's pixels, which the host cannot. */
export default function activate(_context: WindowExtensionContext): WindowExtension {
  return {
    handle(command: string, input?: unknown): Promise<WindowScreenshot> {
      if (command !== "screenshot") throw new Error(`Packages' window half has no command "${command}".`);
      return screenshotWorkbench(workbenchWindow(), input);
    },
  };
}
