import { useHostClient } from "../host-client-context";
import type { Rect } from "./ui/floating";

/**
 * macOS draws the real traffic lights over the title bar (titleBarStyle
 * "hiddenInset"), so the bar only has to keep that corner clear. Everywhere else
 * — other platforms, and the browser preview — there is nothing to make room for.
 */
export function WindowControlsInset() {
  const client = useHostClient();
  if (client?.platform !== "darwin") return null;
  return <div className="window-controls-inset" aria-hidden />;
}

/**
 * The corner the native traffic lights cover, in page pixels: the lights sit at
 * `trafficLightPosition` in src/main/index.ts and ignore page zoom. Floats keep out of it.
 */
export function windowControlsArea(platform: string | undefined): Rect | undefined {
  if (platform !== "darwin") return undefined;
  const zoom = Number.parseFloat(document.documentElement.style.getPropertyValue("--page-zoom")) || 1;
  return { left: 0, top: 0, width: 80 / zoom, height: 40 / zoom };
}
