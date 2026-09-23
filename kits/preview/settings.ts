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

export function defaultsFromPreferences(preferences: PreferenceReader): PreviewDefaults {
  const value = (key: string) => preferences.value(PREVIEW_HOST_EXTENSION_ID, key);
  return readDefaults({
    viewport: value(PREVIEW_SETTINGS.viewport),
    zoom: value(PREVIEW_SETTINGS.zoom),
    appearance: value(PREVIEW_SETTINGS.appearance),
    recording: {
      frameRate: value(PREVIEW_SETTINGS.frameRate),
      showKeys: preferences.optionValue(PREVIEW_HOST_EXTENSION_ID, PREVIEW_SETTINGS.showKeys, false),
      showClicks: preferences.optionValue(PREVIEW_HOST_EXTENSION_ID, PREVIEW_SETTINGS.showClicks, false),
    },
  });
}

/** The floating preview is on unless the user turned it off. */
export function floatingEnabled(preferences: PreferenceReader): boolean {
  return preferences.optionValue(PREVIEW_HOST_EXTENSION_ID, PREVIEW_SETTINGS.floating, true);
}

/**
 * Hands the defaults to the host, now and whenever Settings change them; the
 * host opens pages with them. Answers the unsubscribe.
 */
export function syncDefaults(preferences: PreferenceReader & Pick<PreferencesStore, "subscribe">, send: (defaults: PreviewDefaults) => Promise<unknown>): () => void {
  let sent = "";
  const push = () => {
    const defaults = defaultsFromPreferences(preferences);
    const encoded = JSON.stringify(defaults);
    if (encoded === sent) return;
    sent = encoded;
    void send(defaults).catch(() => { sent = ""; });
  };
  push();
  return preferences.subscribe(push);
}
