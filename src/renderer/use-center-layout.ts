import { useEffect, useRef, useState } from "react";
import { centerLayout, type CenterLayout, type CenterLayoutInput } from "../workbench/center-layout";

export interface CenterLayoutView extends CenterLayout {
  /** The dock yielded and the user asked for it anyway: it stays open until the stage closes or a tab opens. */
  keepDock(): void;
}

/**
 * `centerLayout` for this window, plus who last asked for room: showing or
 * picking a dock panel while the stage is up keeps the dock open; a newly
 * opened tab asks for room again. Closing the stage clears both and the maximize.
 */
export function useCenterLayout(input: Omit<CenterLayoutInput, "keepDock"> & {
  tabCount: number;
  /** Grows with each call that shows, hides or picks a dock panel; a restore leaves it alone. */
  dockAsks: number;
  clearMaximized(): void;
}): CenterLayoutView {
  const { tabCount, dockAsks, clearMaximized, ...layout } = input;
  const [dockKept, setDockKept] = useState(false);
  const last = useRef({ dockAsks, tabCount });
  useEffect(() => {
    if (tabCount === 0) { setDockKept(false); clearMaximized(); }
    else if (last.current.dockAsks !== dockAsks) setDockKept(true);
    else if (tabCount > last.current.tabCount) setDockKept(false);
    last.current = { dockAsks, tabCount };
  }, [dockAsks, tabCount, clearMaximized]);
  return { ...centerLayout({ ...layout, keepDock: dockKept }), keepDock: () => setDockKept(true) };
}
