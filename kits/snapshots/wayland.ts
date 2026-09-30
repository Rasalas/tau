import { desktopCapturer } from "electron";
import type { SnapShotCapture } from "./protocol.js";

/** The portal returns only the source the person selected, not a desktop window index. */
export interface SelectedWindow {
  id: string;
  name: string;
  thumbnail: {
    isEmpty(): boolean;
    getSize(): { width: number; height: number };
    toPNG(): Buffer;
  };
}

/**
 * Electron's PipeWire backend opens the desktop portal chooser for this call.
 * The generic PipeWire capturer requires both source types. Never list at startup to check availability,
 * and never infer accessibility identity from the window focused afterwards.
 * Pattern verified against T3 Code v0.0.44 DesktopSnapShot.ts and Electron
 * v44.0.0 shell/browser/api/electron_api_desktop_capturer.cc lines 371-390.
 * Only the generic capturer, requested with both types, sets
 * auto_show_delegated_source_list=true. This implementation is Tau's own.
 */
export async function captureWaylandWindow(
  select: () => Promise<SelectedWindow[]> = () => desktopCapturer.getSources({ types: ["window", "screen"], thumbnailSize: { width: 1920, height: 1920 }, fetchWindowIcons: false }),
  now: () => number = Date.now,
): Promise<SnapShotCapture> {
  let sources: SelectedWindow[];
  try {
    sources = await select();
  } catch (error) {
    throw new Error(`The desktop's window picker could not capture a window. Check xdg-desktop-portal, your desktop's portal backend and PipeWire. ${error instanceof Error ? error.message : String(error)}`);
  }
  if (sources.length === 0) throw new Error("Window selection was cancelled.");
  if (sources.length !== 1) throw new Error("The desktop did not return one selected window. Tau did not capture another source.");
  const source = sources[0]!;
  // Electron marks the generic PipeWire selection as a window even when the
  // portal offered a display. The chooser, not this id, establishes consent.
  if (!/^(?:window|screen):/u.test(source.id)) throw new Error("The desktop returned an invalid selected source.");
  if (source.thumbnail.isEmpty()) throw new Error("The selected window returned no picture. No SnapShot was stored.");
  const { width, height } = source.thumbnail.getSize();
  const png = source.thumbnail.toPNG();
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || png.length === 0 || png.length > 16 * 1024 * 1024) throw new Error("The selected window returned an invalid or oversized picture.");
  return {
    app: "Selected source",
    title: source.name.slice(0, 1000),
    pid: 0,
    capturedAt: now(),
    image: { data: png.toString("base64"), mimeType: "image/png", width, height },
    accessibilityNote: "Chosen through the desktop picker. It does not identify the app, so accessibility text is omitted.",
  };
}
