import type { PreferencesStore } from "tau";
import { REVIEW_HOST_EXTENSION_ID } from "./protocol.js";

export const SPLIT_OPTION = "split-diff";
export const WHITESPACE_OPTION = "diff-ignore-whitespace";
export const COLLAPSED_OPTION = "diff-files-collapsed";
export const WRAP_OPTION = "diff-word-wrap";
export const COLORS_KEY = "diff-colors";

export type DiffColorScheme = "red-green" | "blue-orange";

export function diffColorScheme(preferences: PreferencesStore): DiffColorScheme {
  return preferences.value(REVIEW_HOST_EXTENSION_ID, COLORS_KEY) === "blue-orange" ? "blue-orange" : "red-green";
}

/** Long lines wrap unless the user turned that off. */
export function diffWordWrap(preferences: PreferencesStore): boolean {
  return preferences.optionValue(REVIEW_HOST_EXTENSION_ID, WRAP_OPTION, true);
}

let wrapDefault = true;

/** The wrap a diff view starts with where no preferences store reaches it (the pull-request view). */
export function currentDiffWordWrap(): boolean {
  return wrapDefault;
}

/**
 * Puts the colour scheme on `<html>` as `data-diff-colors`, which the kit's
 * stylesheet turns into the blue and orange tokens, and mirrors the wrap
 * default, for as long as the kit is active. The returned function undoes both.
 */
export function trackDiffSettings(preferences: PreferencesStore, root: HTMLElement = document.documentElement): () => void {
  const apply = () => {
    wrapDefault = diffWordWrap(preferences);
    if (diffColorScheme(preferences) === "blue-orange") root.dataset.diffColors = "blue-orange";
    else delete root.dataset.diffColors;
  };
  apply();
  const unsubscribe = preferences.subscribe(apply);
  return () => {
    unsubscribe();
    wrapDefault = true;
    delete root.dataset.diffColors;
  };
}
