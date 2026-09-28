import { useEffect } from "react";
import { centerLayout, type CenterLayout, type CenterLayoutInput } from "../workbench/center-layout";

/** `centerLayout` for this window; a stage that runs out of tabs leaves the maximize too. */
export function useCenterLayout(input: CenterLayoutInput & { tabCount: number; clearMaximized(): void }): CenterLayout {
  const { tabCount, clearMaximized, ...layout } = input;
  useEffect(() => {
    if (tabCount === 0) clearMaximized();
  }, [tabCount, clearMaximized]);
  return centerLayout(layout);
}
