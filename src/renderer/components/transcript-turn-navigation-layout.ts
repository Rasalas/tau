/** Eight pixels keeps short threads airy while dense histories still fit on screen. */
export const TRANSCRIPT_TURN_NAVIGATION_ITEM_SPACING = 8 as const;

/** Avoid adding an unbounded number of decorative lines to very long threads. */
export const MAX_TRANSCRIPT_TURN_NAVIGATION_MARKERS = 120 as const;

export function transcriptTurnNavigationTopPercent(index: number, entryCount: number): number {
  if (entryCount <= 1) return 0;
  return (Math.max(0, Math.min(index, entryCount - 1)) / (entryCount - 1)) * 100;
}

export function transcriptTurnNavigationHeight(entryCount: number): string {
  const naturalHeight = Math.max(1, (entryCount - 1) * TRANSCRIPT_TURN_NAVIGATION_ITEM_SPACING);
  return `min(${naturalHeight}px, calc(100% - 10rem))`;
}

export function transcriptTurnNavigationIndexFromPointer(input: {
  entryCount: number;
  railTop: number;
  railHeight: number;
  pointerY: number;
}): number | null {
  if (input.entryCount <= 0 || !Number.isFinite(input.railHeight) || input.railHeight <= 0) return null;
  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight));
  return Math.max(0, Math.min(input.entryCount - 1, Math.round(progress * (input.entryCount - 1))));
}

export function transcriptTurnNavigationMarkerIndexes(entryCount: number): number[] {
  if (entryCount <= 0) return [];
  const markerCount = Math.min(entryCount, MAX_TRANSCRIPT_TURN_NAVIGATION_MARKERS);
  if (markerCount === entryCount) return Array.from({ length: entryCount }, (_, index) => index);
  return Array.from({ length: markerCount }, (_, index) => (
    Math.round((index / (markerCount - 1)) * (entryCount - 1))
  ));
}
