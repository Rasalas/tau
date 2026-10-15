/** A control block's width with its labels, and with only its icons. */
export interface FooterBlockWidths {
  natural: number;
  icon: number;
  /** The narrowest it draws, shortened with an ellipsis (the model); `natural` without. */
  min?: number;
}

export interface FooterMeasurement {
  /** Width the row may fill. */
  available: number;
  gap: number;
  /** Items that always stay; `icon` is their width with the lead controls collapsed. */
  fixed: readonly FooterBlockWidths[];
  /** Lead controls that shrink to their icons and status controls that leave the row (`icon` 0), all at once and before anything else folds. */
  lead?: readonly FooterBlockWidths[];
  /** The blocks that may shrink, in row order; the last one shrinks first. */
  blocks: readonly FooterBlockWidths[];
  /** The overflow trigger, drawn once a block moved into it. */
  overflow: number;
  /** Room the row gains once the labels beside it (the send button's words) drop: the last step. */
  trailingGain?: number;
}

export interface FooterLayout {
  /** The lead controls drawn as icons only, the status controls out of the row. */
  leadIcons: boolean;
  /** Trailing blocks drawn as icons only. */
  iconOnly: number;
  /** Trailing blocks moved into the overflow menu. */
  hidden: number;
  /** The labels beside the row drawn as icons only. */
  trailingIcons: boolean;
}

const SLACK_PX = 1;

function widthAt(input: FooterMeasurement, layout: FooterLayout, shortened = false): number {
  const lead = input.lead ?? [];
  const visible = input.blocks.length - layout.hidden;
  let width = input.fixed.reduce((sum, value) => {
    const drawn = layout.leadIcons ? value.icon : value.natural;
    return sum + (shortened ? Math.min(drawn, value.min ?? drawn) : drawn);
  }, 0);
  // A control that left the row takes its gap along.
  const leadDrawn = lead.filter((entry) => (layout.leadIcons ? entry.icon : entry.natural) > 0);
  for (const entry of leadDrawn) width += layout.leadIcons ? entry.icon : entry.natural;
  for (let index = 0; index < visible; index += 1) {
    const block = input.blocks[index]!;
    width += index >= input.blocks.length - layout.iconOnly ? block.icon : block.natural;
  }
  if (layout.hidden > 0) width += input.overflow;
  const items = input.fixed.length + leadDrawn.length + visible + (layout.hidden > 0 ? 1 : 0);
  return width + input.gap * Math.max(0, items - 1);
}

/** The layout after `step` folds: the lead controls (when there are any), then each block's label, then each block, then the labels beside the row (when they give room). */
function layoutAt(step: number, count: number, hasLead: boolean): FooterLayout {
  const blocks = step - (hasLead ? 1 : 0);
  return { leadIcons: hasLead && step > 0, iconOnly: Math.min(Math.max(blocks, 0), count), hidden: Math.min(Math.max(0, blocks - count), count), trailingIcons: blocks > count * 2 };
}

const stepOf = (layout: FooterLayout, count: number) => (layout.leadIcons ? 1 : 0) + (layout.trailingIcons ? count * 2 + 1 : layout.hidden > 0 ? count + Math.min(layout.hidden, count) : Math.min(layout.iconOnly, count));

/**
 * The composer footer: the lead controls shrink to their icons first, then the
 * trailing blocks drop their labels and move into the overflow menu, one at a
 * time from the end, and last the labels beside the row drop theirs. Growing back needs a pixel of room more than shrinking, so
 * a width on the edge cannot flip the row between two layouts.
 */
export function fitFooterControls(input: FooterMeasurement, previous?: FooterLayout): FooterLayout {
  const count = input.blocks.length;
  const hasLead = (input.lead?.length ?? 0) > 0;
  const gain = input.trailingGain ?? 0;
  const steps = (hasLead ? 1 : 0) + count * 2 + (gain > 0 ? 1 : 0);
  const previousStep = previous ? stepOf(previous, count) : 0;
  // The labels beside the row drop only for a row that would overlap them, not to spare the model its ellipsis.
  const lastFold = steps - (gain > 0 ? 1 : 0);
  const fits = (step: number) => {
    const layout = layoutAt(step, count, hasLead);
    return widthAt(input, layout, step === lastFold && gain > 0) <= input.available + (layout.trailingIcons ? gain : 0) - (step < previousStep ? SLACK_PX : 0);
  };
  let step = 0;
  while (step < steps && !fits(step)) step += 1;
  return layoutAt(step, count, hasLead);
}
