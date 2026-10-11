import { useSyncExternalStore } from "react";
import type { FrameColorScheme } from "../shared/sandbox-frame";

/** Custom themes declare a single CSS scheme; system themes follow the device. */
export function currentColorScheme(): FrameColorScheme {
  const root = document.documentElement;
  const preference = root.dataset.theme;
  if (preference === "light" || preference === "dark") return preference;
  const scheme = getComputedStyle(root).colorScheme.trim();
  if (scheme === "light" || scheme === "dark") return scheme;
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
  const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
  media?.addEventListener("change", onChange);
  return () => { observer.disconnect(); media?.removeEventListener("change", onChange); };
}

/** The workbench's current colour scheme, live (data-theme, custom theme color-scheme, OS preference). */
export function useColorScheme(): FrameColorScheme {
  return useSyncExternalStore(subscribe, currentColorScheme, () => "light");
}
