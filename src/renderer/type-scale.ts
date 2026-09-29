import { TABLET_SCREEN_MIN_SIDE_PX, type ClientProfile } from "../workbench/client-profile";

/**
 * The reading distance a client is drawn for (ADR 0029): a desktop at the
 * design's sizes, a tablet and a phone a step or two larger. `tokens.css`
 * sets each text role again under `data-device` on <html>.
 */
export type DeviceClass = "desktop" | "tablet" | "phone";

/**
 * A touch client on a phone-sized screen is a phone, on a larger one a tablet;
 * everything else, a narrowed desktop window included, keeps the desktop's.
 * The screen decides, not the window: an iPad in Slide Over is read as an iPad.
 */
export function deviceClassFor(profile: ClientProfile, touch: boolean, screenMinSide: number): DeviceClass {
  if (profile !== "compact" || !touch) return "desktop";
  return screenMinSide < TABLET_SCREEN_MIN_SIDE_PX ? "phone" : "tablet";
}

/** iOS Body at the system's default text size: what Dynamic Type calls 1×. */
export const SYSTEM_BODY_PX = 17;
/** Smaller system sizes keep the default: below it a phone's meta would fall under 12px. */
export const TEXT_SCALE_MIN = 1;
/** iOS's largest standard size is 1.35×, Android's 1.3× (2× since Android 14); past 1.5 a phone's rows no longer hold their line. */
export const TEXT_SCALE_MAX = 1.5;

export function clampTextScale(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 1;
  return Math.round(Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, value)) * 100) / 100;
}

/** The system's text size as a factor over its default; `read` is undefined where the platform does not say. */
export interface SystemTextScale {
  read(): number | undefined;
  subscribe(listener: () => void): () => void;
}

/**
 * iOS Dynamic Type, in Safari and in the app's web view: WebKit draws
 * `-apple-system-body` at the Body size the user chose. A hidden probe carries
 * it; a change resizes the probe, and a return to the app re-reads it.
 */
export function appleDynamicType(doc: Document = document): SystemTextScale | undefined {
  const view = doc.defaultView;
  if (!view || typeof view.CSS?.supports !== "function" || !view.CSS.supports("font", "-apple-system-body")) return undefined;
  const probe = doc.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.className = "system-text-probe";
  probe.style.cssText = "position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;white-space:nowrap;font:-apple-system-body";
  probe.textContent = "x";
  doc.body.append(probe);
  return {
    read: () => {
      const px = Number.parseFloat(view.getComputedStyle(probe).fontSize);
      return Number.isFinite(px) && px > 0 ? px / SYSTEM_BODY_PX : undefined;
    },
    subscribe: (listener) => {
      const observer = typeof view.ResizeObserver === "function" ? new view.ResizeObserver(() => listener()) : undefined;
      observer?.observe(probe);
      const onShown = () => { if (doc.visibilityState === "visible") listener(); };
      doc.addEventListener("visibilitychange", onShown);
      return () => { observer?.disconnect(); doc.removeEventListener("visibilitychange", onShown); };
    },
  };
}

/**
 * Marks <html> with the device class and keeps `--text-scale` at the system's
 * text size. Tau's own Text size (Appearance Kit) adds its step on top.
 */
export function applyTypeScale(device: DeviceClass, system?: SystemTextScale, root: HTMLElement = document.documentElement): () => void {
  if (device === "desktop") {
    delete root.dataset.device;
    root.style.removeProperty("--text-scale");
    return () => undefined;
  }
  root.dataset.device = device;
  const update = () => {
    const scale = clampTextScale(system?.read());
    if (scale === 1) root.style.removeProperty("--text-scale");
    else root.style.setProperty("--text-scale", String(scale));
  };
  update();
  const stop = system?.subscribe(update);
  return () => {
    stop?.();
    delete root.dataset.device;
    root.style.removeProperty("--text-scale");
  };
}
