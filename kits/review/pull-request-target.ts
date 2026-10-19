import { useSyncExternalStore } from "react";
import type { PreferencesStore } from "tau";
import { REVIEW_HOST_EXTENSION_ID } from "./protocol.js";

export const PULL_REQUEST_TARGET_KEY = "pull-request-target";

export type PullRequestTarget = "tau" | "browser";

export function readPullRequestTarget(raw: unknown): PullRequestTarget {
  return raw === "browser" ? "browser" : "tau";
}

let current: PullRequestTarget = "tau";
const listeners = new Set<() => void>();

/** Where a request link opens: Tau's own view (default) or the provider's site. */
export function pullRequestTarget(): PullRequestTarget {
  return current;
}

/** React's view of the setting, for a row that offers the other target. */
export function usePullRequestTarget(): PullRequestTarget {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, pullRequestTarget);
}

/** Mirrors the setting for `openPullRequest`, which no preferences store reaches, for as long as the kit is active. */
export function trackPullRequestTarget(preferences: PreferencesStore): () => void {
  const apply = () => {
    const next = readPullRequestTarget(preferences.value(REVIEW_HOST_EXTENSION_ID, PULL_REQUEST_TARGET_KEY));
    if (next === current) return;
    current = next;
    for (const listener of [...listeners]) listener();
  };
  apply();
  const unsubscribe = preferences.subscribe(apply);
  return () => {
    unsubscribe();
    current = "tau";
    for (const listener of [...listeners]) listener();
  };
}
