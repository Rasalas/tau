import type { Device, FoldState } from "./protocol.js";
export type BodyLayout = "phone" | "tablet" | "book" | "flip" | "dual";
export interface BodyProfile { layout: BodyLayout; label: string; identified: boolean }
/** Family shapes only. Device discovery does not supply a measured hardware mesh. */
export function bodyProfile(device: Pick<Device, "name" | "platform">, fold?: FoldState): BodyProfile {
  const name = device.name.replaceAll("_", " ");
  if (device.platform === "android") {
    if (/\b(surface duo|dual[ -]?screen)\b/i.test(name)) return { layout: "dual", label: "Dual screen family", identified: true };
    if (/\b(flip|clamshell)\b/i.test(name)) return { layout: "flip", label: "Clamshell family", identified: true };
    if (/\b(fold|foldable)\b/i.test(name)) return { layout: "book", label: "Book foldable family", identified: true };
    if (fold?.supported) return { layout: "book", label: "Generic foldable", identified: false };
  }
  const tablet = /\b(ipad|tablet)\b/i.test(name);
  return { layout: tablet ? "tablet" : "phone", label: tablet ? "Tablet family" : "Generic device", identified: tablet || /\b(iphone|pixel|phone)\b/i.test(name) };
}
export interface PanelGeometry {
  x: number; y: number; width: number; height: number;
  origin: string; transform: string;
  /** Fractions of the one native capture. Each pixel belongs to one panel. */
  crop: { x: number; y: number; width: number; height: number };
}
export const articulated = (layout: BodyLayout) => ["book", "flip", "dual"].includes(layout);
/** Front faces pivot at z=0; solid bodies extend behind them, avoiding collision at closure. */
export function panelGeometry(layout: BodyLayout, width: number, height: number, angle: number): PanelGeometry[] {
  if (!articulated(layout)) return [{ x: 0, y: 0, width, height, origin: "center", transform: "none", crop: { x: 0, y: 0, width: 1, height: 1 } }];
  const turn = (180 - Math.max(0, Math.min(layout === "dual" ? 360 : 180, angle))) / 2;
  if (layout === "flip") return [
    { x: 0, y: 0, width, height: height / 2, origin: "center bottom", transform: `rotateX(${-turn}deg)`, crop: { x: 0, y: 0, width: 1, height: .5 } },
    { x: 0, y: height / 2, width, height: height / 2, origin: "center top", transform: `rotateX(${turn}deg)`, crop: { x: 0, y: .5, width: 1, height: .5 } },
  ];
  return [
    { x: 0, y: 0, width: width / 2, height, origin: "right center", transform: `rotateY(${turn}deg)`, crop: { x: 0, y: 0, width: .5, height: 1 } },
    { x: width / 2, y: 0, width: width / 2, height, origin: "left center", transform: `rotateY(${-turn}deg)`, crop: { x: .5, y: 0, width: .5, height: 1 } },
  ];
}
export interface ScreenSize { width: number; height: number }
export type CaptureSurface = "front" | "cover" | "unmapped";
/** A native closed capture may be a cover screen. Never stretch it over two interior panels. */
export function captureSurface(layout: BodyLayout, size: ScreenSize, inner: ScreenSize | undefined, fold?: FoldState): CaptureSurface {
  if (!articulated(layout)) return "front";
  if (!fold?.supported || fold.posture === null || fold.posture === "flipped" || fold.posture === "tent") return "unmapped";
  if (fold.posture === "closed") return layout === "book" && inner && Math.abs(size.width / size.height - inner.width / inner.height) > .025 ? "cover" : "unmapped";
  if (inner && Math.abs(size.width / size.height - inner.width / inner.height) > .025) return "unmapped";
  return "front";
}
export function nativeAngle(fold?: FoldState): number | undefined {
  if (!fold?.supported) return undefined;
  if (fold.hingeAngle !== null) return fold.hingeAngle;
  return fold.posture === "closed" ? 0 : fold.posture === "opened" ? 180 : undefined;
}
/** Integer crop boundaries keep an odd-sized native capture's centre pixel on exactly one panel. */
export function captureRegion(size: ScreenSize, crop: PanelGeometry["crop"]): { x: number; y: number; width: number; height: number } {
  const x = Math.floor(size.width * crop.x), y = Math.floor(size.height * crop.y);
  return { x, y, width: Math.floor(size.width * (crop.x + crop.width)) - x, height: Math.floor(size.height * (crop.y + crop.height)) - y };
}
