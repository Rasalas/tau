import { BrowserWindow, nativeImage, type NativeImage, type WebContents } from "electron";
import type { WindowExtension, WindowExtensionContext } from "tau/host-extension";
import { cropAround, toImagePixels, type Box, type Size, type WindowScreenshot } from "./screenshot-crop.js";

const DEFAULT_MAX_WIDTH = 1_600;
/** A package installed a moment ago may not have drawn its parts yet; how long and how often to look again. */
const PATIENCE_MS = 2_000;
const POLL_MS = 150;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The workbench window of this process: visible or minimized, never a hidden helper page; the focused one first. */
function workbenchWindow(): BrowserWindow | undefined {
  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed() && (window.isVisible() || window.isMinimized()));
  return windows.find((window) => window.isFocused()) ?? windows[0];
}

/** Resolves once the page has painted what it holds now, so the picture taken next is not a frame older than the page. */
const PAINTED_SCRIPT = "new Promise((resolve) => { setTimeout(resolve, 300); requestAnimationFrame(() => requestAnimationFrame(resolve)); })";

/** Waits for a paint, then reads the page's size and the boxes of the parts `data-tau-extension-id` marks as the extension's. */
const regionsScript = (extensionId: string): string => `(async (id) => {
  await ${PAINTED_SCRIPT};
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
  return { viewport: { width: window.innerWidth, height: window.innerHeight }, pixelRatio: window.devicePixelRatio, parts };
})(${JSON.stringify(extensionId)})`;

interface RegionReading { viewport: Size; pixelRatio?: number; parts: Array<{ part: string; boxes: Box[] }> }

const fields = (input: unknown): Record<string, unknown> => input && typeof input === "object" ? input as Record<string, unknown> : {};

/**
 * The page rendered afresh through the debugger protocol. `capturePage` hands back the last frame the
 * window showed, which is an old one while the window sits behind another and paints nothing.
 */
async function renderedPicture(contents: WebContents, crop: Box | undefined, pixelRatio: number): Promise<NativeImage | undefined> {
  const session = contents.debugger;
  try {
    const attachedHere = !session.isAttached();
    if (attachedHere) session.attach("1.3");
    try {
      const { data } = await session.sendCommand("Page.captureScreenshot", {
        format: "png", fromSurface: true, ...(crop ? { clip: { ...crop, scale: pixelRatio } } : {}),
      }) as { data: string };
      const picture = nativeImage.createFromBuffer(Buffer.from(data, "base64"));
      return picture.isEmpty() ? undefined : picture;
    } finally {
      if (attachedHere && session.isAttached()) session.detach();
    }
  } catch {
    return undefined;
  }
}

/** One picture of Tau's own window; there is no way to name another window or a screen. */
export async function screenshotWorkbench(window: BrowserWindow | undefined, input: unknown, patienceMs = PATIENCE_MS): Promise<WindowScreenshot> {
  if (!window) return { available: false, reason: "Tau has no open window on this machine." };
  if (window.isMinimized()) return { available: false, reason: "Tau's window is minimized; the user has to bring it back first." };
  const { extension, margin, maxWidth } = fields(input);
  const contents = window.webContents;
  const extensionId = typeof extension === "string" && extension.trim() ? extension.trim() : undefined;
  let crop: Box | undefined;
  let parts: string[] = [];
  let viewport: Size | undefined;
  let pixelRatio = 1;
  if (extensionId) {
    const until = Date.now() + patienceMs;
    for (;;) {
      const reading = await contents.executeJavaScript(regionsScript(extensionId)) as RegionReading;
      viewport = reading.viewport;
      pixelRatio = reading.pixelRatio && reading.pixelRatio > 0 ? reading.pixelRatio : 1;
      crop = cropAround(reading.parts.flatMap((part) => part.boxes), viewport, typeof margin === "number" ? margin : undefined);
      parts = reading.parts.filter((part) => part.boxes.length > 0).map((part) => part.part);
      if (crop || Date.now() >= until) break;
      await sleep(POLL_MS);
    }
  } else {
    await contents.executeJavaScript(PAINTED_SCRIPT);
  }
  let shown = await renderedPicture(contents, crop, pixelRatio);
  if (!shown) {
    const image = await contents.capturePage();
    if (image.isEmpty()) return { available: false, reason: "The window gave no picture; it may be hidden behind another window or still starting." };
    shown = crop && viewport ? image.crop(toImagePixels(crop, viewport, image.getSize())) : image;
  }
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
