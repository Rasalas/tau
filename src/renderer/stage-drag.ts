/**
 * What a tab dragged off the strip may do where it is let go: join the strip
 * at a slot, or split the stage below it. One reading of the pointer for both,
 * so a reorder inside the strip can never also split.
 */

/** What a tab dragged off the strip carries: its id. */
export const STAGE_TAB_DRAG = "application/x-tau-stage-tab";

export type StageDrop =
  | { kind: "split" }
  /** `beforeId` is the tab it lands in front of; absent means the end of the strip. */
  | { kind: "reorder"; beforeId: string | undefined };

/** The tab a pointer at `x` lands in front of: the first whose middle lies right of it. */
export function insertionSlot(tabs: readonly { id: string; left: number; width: number }[], x: number): string | undefined {
  return tabs.find((tab) => x < tab.left + tab.width / 2)?.id;
}

export function carriesStageTab(event: DragEvent): boolean {
  return !!event.dataTransfer?.types.includes(STAGE_TAB_DRAG);
}

/** The drop the pointer means, or none: a strip with one tab has no order, and its buttons take no drop. */
export function stageDropAt(event: DragEvent, tabCount: number): StageDrop | undefined {
  if (tabCount < 2 || !carriesStageTab(event)) return undefined;
  const target = event.target as Element;
  const frame = target.closest?.(".stage-tabs-frame");
  if (frame) {
    const tabs = [...frame.querySelectorAll<HTMLElement>(".stage-tab")].map((tab) => {
      const box = tab.getBoundingClientRect();
      return { id: tab.dataset.tabId ?? "", left: box.left, width: box.width };
    });
    return { kind: "reorder", beforeId: insertionSlot(tabs, event.clientX) };
  }
  if (target.closest?.(".stage-strip") || !target.closest?.(".stage")) return undefined;
  return { kind: "split" };
}
