import { useEffect, useState } from "react";
import { compactFormFor, layoutProfileFor, type ClientProfile, type CompactForm } from "../workbench/client-profile";

/**
 * The layout viewport's width. Unlike `innerWidth` on iOS, it does not shrink
 * when the page is zoomed (a focused small field, a pinch).
 */
export function layoutWidth(): number {
  return document.documentElement.clientWidth || window.innerWidth;
}

/** The screen's shorter side; unknown (a test's DOM) counts as a tablet's. */
export function screenMinSide(): number {
  const side = Math.min(window.screen?.width ?? 0, window.screen?.height ?? 0);
  return side > 0 ? side : Number.POSITIVE_INFINITY;
}

/**
 * Re-decides on each resize while the page is shown. A hidden page keeps its
 * layout: iOS resizes an app in the background for its snapshots.
 */
function useWidthDecision<T>(decide: (previous: T | undefined) => T, deps: readonly unknown[]): T {
  const [value, setValue] = useState(() => decide(undefined));
  useEffect(() => {
    const update = () => {
      if (document.visibilityState === "hidden") return;
      setValue((previous) => decide(previous));
    };
    update();
    window.addEventListener("resize", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("resize", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, deps);
  return value;
}

/**
 * How wide the client is right now, as a profile. The claim a contribution
 * made stays what it was — the registry keeps whatever it registered — but
 * anything narrower than `COMPACT_WIDTH_PX` lays itself out compactly, which
 * is one attribute on `body` and a handful of conditions in the workbench.
 */
export function useLayoutProfile(profile: ClientProfile): ClientProfile {
  const layout = useWidthDecision<ClientProfile>((previous) => layoutProfileFor(profile, layoutWidth(), previous), [profile]);
  useEffect(() => {
    document.body.dataset.profile = layout;
    document.body.dataset.client = profile;
  }, [layout, profile]);
  return layout;
}

/** Phone or tablet arrangement of a compact client (`compactFormFor`), stable against height and content. */
export function useCompactForm(profile: ClientProfile): CompactForm {
  return useWidthDecision<CompactForm>((previous) => compactFormFor(profile, layoutWidth(), screenMinSide(), previous), [profile]);
}
