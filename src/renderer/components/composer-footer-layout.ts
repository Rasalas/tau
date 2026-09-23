/** A control block's width with its labels, and with only its icons. */
export interface FooterBlockWidths {
  natural: number;
  icon: number;
}

export interface FooterMeasurement {
  /** Width the row may fill. */
  available: number;
  gap: number;
  /** Items that always stay, such as the model chip, at their natural width. */
  fixed: readonly number[];
  /** The blocks that may shrink, in row order; the last one shrinks first. */
  blocks: readonly FooterBlockWidths[];
  /** The overflow trigger, drawn once a block moved into it. */
  overflow: number;
}

export interface FooterLayout {
  /** Trailing blocks drawn as icons only. */
  iconOnly: number;
  /** Trailing blocks moved into the overflow menu. */
  hidden: number;
}

const SLACK_PX = 1;

function widthAt(input: FooterMeasurement, iconOnly: number, hidden: number): number {
  const visible = input.blocks.length - hidden;
  let width = input.fixed.reduce((sum, value) => sum + value, 0);
  for (let index = 0; index < visible; index += 1) {
    const block = input.blocks[index]!;
    width += index >= input.blocks.length - iconOnly ? block.icon : block.natural;
  }
  if (hidden > 0) width += input.overflow;
  const items = input.fixed.length + visible + (hidden > 0 ? 1 : 0);
  return width + input.gap * Math.max(0, items - 1);
}

const stepOf = (layout: FooterLayout, count: number) => (layout.hidden > 0 ? count + Math.min(layout.hidden, count) : Math.min(layout.iconOnly, count));

/**
 * As T3 Code's composer footer: trailing blocks drop their labels first, then
 * move into the overflow menu, one at a time from the end. Growing back needs
 * a pixel of room more than shrinking, so a width on the edge cannot flip the
 * row between two layouts.
 */
export function fitFooterControls(input: FooterMeasurement, previous?: FooterLayout): FooterLayout {
  const count = input.blocks.length;
  const previousStep = previous ? stepOf(previous, count) : 0;
  let step = 0;
  const at = (candidate: number) => widthAt(input, Math.min(candidate, count), Math.max(0, candidate - count));
  while (step < count * 2 && at(step) > input.available - (step < previousStep ? SLACK_PX : 0)) step += 1;
  return { iconOnly: Math.min(step, count), hidden: Math.max(0, step - count) };
}
