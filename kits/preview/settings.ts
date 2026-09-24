import type { PreferencesStore } from "tau";
import { PREVIEW_HOST_EXTENSION_ID, type PreviewDefaults } from "./protocol.js";
import { readDefaults } from "./viewport.js";

/** Settings → Preview's keys: strings under `values.tau.preview`, switches under `options.tau.preview`. */
export const PREVIEW_SETTINGS = {
  viewport: "default-viewport",
  zoom: "default-zoom",
  appearance: "default-appearance",
  linkTarget: "link-target",
  frameRate: "recording-frame-rate",
  showKeys: "recording-keys",
  showClicks: "recording-clicks",
  floating: "floating-preview",
} as const;

/** Where a link clicked in a thread opens: T3 Code's `browserLinkTarget`. */
export type LinkTarget = "system" | "app";

export function readLinkTarget(value: unknown): LinkTarget {
  return value === "app" ? "app" : "system";
}

type PreferenceReader = Pick<PreferencesStore, "value" | "optionValue">;

/** The defaults from the kit's own `values` and `options`, as `services.settings` answers them on the host. */
export function defaultsFromSettings(settings: { values: Readonly<Record<string, string>>; options: Readonly<Record<string, boolean>> }): PreviewDefaults {
  const { values, options } = settings;
  return readDefaults({
    viewport: values[PREVIEW_SETTINGS.viewport],
    zoom: values[PREVIEW_SETTINGS.zoom],
    appearance: values[PREVIEW_SETTINGS.appearance],
    recording: {
      frameRate: values[PREVIEW_SETTINGS.frameRate],
      showKeys: options[PREVIEW_SETTINGS.showKeys] === true,
      showClicks: options[PREVIEW_SETTINGS.showClicks] === true,
    },
  });
}

/** The floating preview is on unless the user turned it off. */
export function floatingEnabled(preferences: PreferenceReader): boolean {
  return preferences.optionValue(PREVIEW_HOST_EXTENSION_ID, PREVIEW_SETTINGS.floating, true);
}
