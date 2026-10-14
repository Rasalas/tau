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
  /** Lead controls that shrink to their icons, all at once and before anything else folds. */
  lead?: readonly FooterBlockWidths[];
  /** The blocks that may shrink, in row order; the last one shrinks first. */
  blocks: readonly FooterBlockWidths[];
  /** The overflow trigger, drawn once a block moved into it. */
  overflow: number;
}

export interface FooterLayout {
  /** The lead controls drawn as icons only. */
  leadIcons: boolean;
  /** Trailing blocks drawn as icons only. */
  iconOnly: number;
  /** Trailing blocks moved into the overflow menu. */
  hidden: number;
}

const SLACK_PX = 1;

function widthAt(input: FooterMeasurement, layout: FooterLayout): number {
  const lead = input.lead ?? [];
  const visible = input.blocks.length - layout.hidden;
  let width = input.fixed.reduce((sum, value) => sum + value, 0);
  for (const entry of lead) width += layout.leadIcons ? entry.icon : entry.natural;
  for (let index = 0; index < visible; index += 1) {
    const block = input.blocks[index]!;
    width += index >= input.blocks.length - layout.iconOnly ? block.icon : block.natural;
  }
  if (layout.hidden > 0) width += input.overflow;
  const items = input.fixed.length + lead.length + visible + (layout.hidden > 0 ? 1 : 0);
  return width + input.gap * Math.max(0, items - 1);
}

/** The layout after `step` folds: the lead controls (when there are any), then each block's label, then each block. */
function layoutAt(step: number, count: number, hasLead: boolean): FooterLayout {
  const blocks = step - (hasLead ? 1 : 0);
  return { leadIcons: hasLead && step > 0, iconOnly: Math.min(Math.max(blocks, 0), count), hidden: Math.max(0, blocks - count) };
}

const stepOf = (layout: FooterLayout, count: number) => (layout.leadIcons ? 1 : 0) + (layout.hidden > 0 ? count + Math.min(layout.hidden, count) : Math.min(layout.iconOnly, count));

/**
 * The composer footer: the lead controls shrink to their icons first, then the
 * trailing blocks drop their labels and move into the overflow menu, one at a
 * time from the end. Growing back needs a pixel of room more than shrinking, so
 * a width on the edge cannot flip the row between two layouts.
 */
export function fitFooterControls(input: FooterMeasurement, previous?: FooterLayout): FooterLayout {
  const count = input.blocks.length;
  const hasLead = (input.lead?.length ?? 0) > 0;
  const steps = (hasLead ? 1 : 0) + count * 2;
  const previousStep = previous ? stepOf(previous, count) : 0;
  let step = 0;
  while (step < steps && widthAt(input, layoutAt(step, count, hasLead)) > input.available - (step < previousStep ? SLACK_PX : 0)) step += 1;
  return layoutAt(step, count, hasLead);
}
