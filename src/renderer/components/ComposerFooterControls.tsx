import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import { ComposerMenuPopover } from "../deferred-surfaces";
import { fitFooterControls, type FooterBlockWidths, type FooterLayout } from "./composer-footer-layout";

export interface FooterBlock {
  id: string;
  node: ReactNode;
  /** What the menu draws once the block folded into it; `node` itself otherwise. */
  menuNode?: ReactNode;
  /** Sits at the row's end, before the send button. */
  end?: boolean;
  /** Blocks with a higher rank fold later; equal ranks fold from the end of the row. */
  rank?: number;
  /** Always in the menu, never in the row. */
  menuOnly?: boolean;
}

interface Measured extends FooterBlockWidths {
  /** `data-composer-shortcut` names inside the block, for the menu trigger to answer to. */
  shortcuts: readonly string[];
}

const NO_LAYOUT: FooterLayout = { iconOnly: 0, hidden: 0 };
const NO_SHORTCUTS: readonly string[] = [];

const px = (value: string) => Number.parseFloat(value) || 0;

/** A chip reduced to its icon: 8 px padding either side of a 13 px icon. Once drawn so, the real width counts. */
const ICON_CHIP = 29;

/** Width of the block with its chips reduced to their icons; a chip without an icon keeps its text. */
function iconWidth(block: HTMLElement, natural: number): number {
  let width = natural;
  for (const chip of block.querySelectorAll(".runtime-chip")) {
    if (!chip.querySelector(":scope > svg")) continue;
    width -= Math.max(0, chip.getBoundingClientRect().width - ICON_CHIP);
  }
  return width;
}

/**
 * The composer's footer row: the model, then the blocks, then one menu ("…")
 * that holds `menu`, the `menuOnly` blocks and every block the row has no room for. As the
 * composer narrows the blocks first drop their labels and then move into the
 * menu, lowest rank first.
 */
export function ComposerFooterControls({ leading, blocks, menu, menuShortcuts = NO_SHORTCUTS, revision = "" }: {
  leading: ReactNode;
  blocks: readonly FooterBlock[];
  /** Entries that always live in the menu. */
  menu?: ReactNode;
  /** Shortcut ids of the controls in `menu`, for the trigger to answer to. */
  menuShortcuts?: readonly string[];
  /** Changes when the chips change in a way the observer cannot see, such as one appearing. */
  revision?: string;
}) {
  const row = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const measured = useRef(new Map<string, Measured>());
  const triggerWidth = useRef(ICON_CHIP);
  const [layout, setLayout] = useState(NO_LAYOUT);
  const [open, setOpen] = useState(false);
  const hasMenu = Boolean(menu);
  // Fold order: the blocks kept longest first, so the fitter takes them from the end.
  const byFold = useMemo(() => blocks
    .filter((block) => !block.menuOnly)
    .map((block, index) => ({ block, index }))
    .sort((a, b) => (b.block.rank ?? 0) - (a.block.rank ?? 0) || a.index - b.index)
    .map((entry) => entry.block), [blocks]);
  // Only blocks seen with content fold; an empty or unseen one stays in the row to be measured.
  const candidates = byFold.filter((block) => (measured.current.get(block.id)?.natural ?? 0) > 0);
  const iconOnly = new Set(candidates.slice(candidates.length - layout.iconOnly).map((block) => block.id));
  const hidden = new Set(layout.hidden > 0 ? candidates.slice(candidates.length - layout.hidden).map((block) => block.id) : []);

  const order = useRef(byFold);
  order.current = byFold;
  const menuAlways = useRef(hasMenu);
  menuAlways.current = hasMenu;
  const measure = useCallback(() => {
    const element = row.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const gap = px(style.columnGap);
    const fixed: number[] = [];
    for (const child of element.children) {
      const item = child as HTMLElement;
      const id = item.dataset.composerBlock;
      if (id !== undefined) {
        const width = item.getBoundingClientRect().width;
        const previous = measured.current.get(id);
        // An icon-only block keeps the label width it had; its icon width is what it shows now.
        const natural = item.dataset.iconOnly !== undefined && previous ? previous.natural : width;
        const icon = item.dataset.iconOnly !== undefined ? width : iconWidth(item, width);
        const shortcuts = [...item.querySelectorAll<HTMLElement>("[data-composer-shortcut]")].flatMap((node) => node.dataset.composerShortcut?.split(/\s+/u) ?? []);
        measured.current.set(id, { natural, icon: Math.min(icon, natural), shortcuts });
      } else if (item.dataset.composerOverflow !== undefined) {
        triggerWidth.current = item.getBoundingClientRect().width;
        if (menuAlways.current) fixed.push(triggerWidth.current);
      } else {
        // The model chip may be shrunk with an ellipsis; count the width its label asks for.
        const label = item.querySelector<HTMLElement>(".runtime-chip-label");
        fixed.push(item.getBoundingClientRect().width + (label ? Math.max(0, label.scrollWidth - label.clientWidth) : 0));
      }
    }
    const widths = order.current.flatMap((block) => {
      const entry = measured.current.get(block.id);
      return entry && entry.natural > 0 ? [entry] : [];
    });
    setLayout((current) => {
      const next = fitFooterControls({
        available: element.clientWidth,
        gap,
        fixed,
        blocks: widths,
        // A menu that is there anyway costs nothing more when a block moves into it.
        overflow: menuAlways.current ? 0 : triggerWidth.current,
      }, current);
      return next.iconOnly === current.iconOnly && next.hidden === current.hidden ? current : next;
    });
  }, []);

  // Not on every render: a keystroke re-renders the composer, and sizes change only through these or the observer.
  const shape = `${blocks.map((block) => `${block.id}${block.menuOnly ? "~" : ""}`).join(" ")}|${layout.iconOnly}|${layout.hidden}|${hasMenu}|${revision}`;
  useLayoutEffect(() => {
    measure();
    const element = row.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => measure());
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [measure, shape]);

  const hiddenBlocks = blocks.filter((block) => block.menuOnly || hidden.has(block.id));
  const inRow = (block: FooterBlock) => !block.menuOnly && !hidden.has(block.id);
  const showTrigger = hasMenu || hiddenBlocks.length > 0;
  if (open && !showTrigger) setOpen(false);
  const shortcuts = [...menuShortcuts, ...hiddenBlocks.flatMap((block) => measured.current.get(block.id)?.shortcuts ?? [])];
  const drawn = (block: FooterBlock) => (
    <span key={block.id} className={`composer-block${block.end ? " end" : ""}`} data-composer-block={block.id} {...(iconOnly.has(block.id) ? { "data-icon-only": "" } : {})}>
      {block.node}
    </span>
  );

  return (
    <div className="composer-chips" ref={row}>
      {leading}
      {blocks.filter((block) => !block.end && inRow(block)).map(drawn)}
      {showTrigger ? (
        <span className="composer-overflow-anchor" data-composer-overflow="">
          <button
            ref={trigger}
            type="button"
            className="runtime-chip composer-menu-trigger"
            aria-label="More composer controls"
            aria-expanded={open}
            aria-haspopup="dialog"
            data-composer-menu=""
            {...(shortcuts.length > 0 ? { "data-composer-shortcut": shortcuts.join(" ") } : {})}
            onClick={() => setOpen((current) => !current)}
          >
            <Ellipsis size={15} />
          </button>
          {open ? (
            <ComposerMenuPopover anchor={trigger} onClose={() => setOpen(false)}>
              {hiddenBlocks.length > 0 ? (
                <div className="composer-overflow-list">
                  {hiddenBlocks.map((block) => <span key={block.id} className="composer-block" data-composer-block={block.id}>{block.menuNode ?? block.node}</span>)}
                </div>
              ) : null}
              {menu}
            </ComposerMenuPopover>
          ) : null}
        </span>
      ) : null}
      {blocks.filter((block) => block.end && inRow(block)).map(drawn)}
    </div>
  );
}
