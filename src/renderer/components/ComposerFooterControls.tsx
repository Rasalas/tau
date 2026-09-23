import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Ellipsis } from "lucide-react";
import { Popover } from "../deferred-surfaces";
import { focusableElements, openedByKeyboard } from "./ui/focus";
import { fitFooterControls, type FooterBlockWidths, type FooterLayout } from "./composer-footer-layout";

export interface FooterBlock {
  id: string;
  node: ReactNode;
}

interface Measured extends FooterBlockWidths {
  /** `data-composer-shortcut` names inside the block, for the overflow trigger to answer to. */
  shortcuts: readonly string[];
}

const NO_LAYOUT: FooterLayout = { iconOnly: 0, hidden: 0 };

const px = (value: string) => Number.parseFloat(value) || 0;

/** A chip reduced to its icon: 8 px padding either side of a 13 px icon. Once drawn so, the real width counts. */
const ICON_CHIP = 29;

/** Width of the block with its chips reduced to their icons, before it has been drawn that way. */
function iconWidth(block: HTMLElement, natural: number): number {
  let width = natural;
  for (const chip of block.querySelectorAll(".runtime-chip")) width -= Math.max(0, chip.getBoundingClientRect().width - ICON_CHIP);
  return width;
}

/**
 * The chips beside the model: the model stays, the blocks after it first
 * lose their labels and then move into an overflow menu, from the end, as the
 * composer narrows (T3 Code's footer). Kit controls are opaque, so a hidden
 * block is drawn inside the overflow popover as it is.
 */
export function ComposerFooterControls({ leading, blocks, revision = "" }: {
  leading: ReactNode;
  blocks: readonly FooterBlock[];
  /** Changes when the leading chips change in a way the observer cannot see, such as one appearing. */
  revision?: string;
}) {
  const row = useRef<HTMLDivElement>(null);
  const overflowRef = useRef<HTMLButtonElement>(null);
  const measured = useRef(new Map<string, Measured>());
  const overflowWidth = useRef(ICON_CHIP);
  const [layout, setLayout] = useState(NO_LAYOUT);
  const [open, setOpen] = useState(false);
  // Only blocks seen with content fold; an empty or unseen one stays in the row to be measured.
  const candidates = blocks.filter((block) => (measured.current.get(block.id)?.natural ?? 0) > 0);
  const iconOnly = new Set(candidates.slice(candidates.length - layout.iconOnly).map((block) => block.id));
  const hidden = new Set(layout.hidden > 0 ? candidates.slice(candidates.length - layout.hidden).map((block) => block.id) : []);

  const order = useRef(blocks);
  order.current = blocks;
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
        overflowWidth.current = item.getBoundingClientRect().width;
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
      const next = fitFooterControls({ available: element.clientWidth, gap, fixed, blocks: widths, overflow: overflowWidth.current }, current);
      return next.iconOnly === current.iconOnly && next.hidden === current.hidden ? current : next;
    });
  }, []);

  // Not on every render: a keystroke re-renders the composer, and sizes change only through these or the observer.
  const shape = `${blocks.map((block) => block.id).join(" ")}|${layout.iconOnly}|${layout.hidden}|${revision}`;
  useLayoutEffect(() => {
    measure();
    const element = row.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => measure());
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [measure, shape]);

  const hiddenBlocks = blocks.filter((block) => hidden.has(block.id));
  if (open && hiddenBlocks.length === 0) setOpen(false);
  const shortcuts = hiddenBlocks.flatMap((block) => measured.current.get(block.id)?.shortcuts ?? []);

  return (
    <div className="composer-chips" ref={row}>
      {leading}
      {blocks.filter((block) => !hidden.has(block.id)).map((block) => (
        <span key={block.id} className="composer-block" data-composer-block={block.id} {...(iconOnly.has(block.id) ? { "data-icon-only": "" } : {})}>
          {block.node}
        </span>
      ))}
      {hiddenBlocks.length > 0 ? (
        <span className="composer-overflow-anchor" data-composer-overflow="">
          <button
            ref={overflowRef}
            type="button"
            className="runtime-chip"
            aria-label="More composer controls"
            aria-expanded={open}
            aria-haspopup="dialog"
            {...(shortcuts.length > 0 ? { "data-composer-shortcut": shortcuts.join(" ") } : {})}
            onClick={() => setOpen((current) => !current)}
          >
            <Ellipsis size={14} />
          </button>
          {open ? <OverflowPopover anchor={overflowRef} blocks={hiddenBlocks} onClose={() => setOpen(false)} /> : null}
        </span>
      ) : null}
    </div>
  );
}

function OverflowPopover({ anchor, blocks, onClose }: { anchor: RefObject<HTMLButtonElement | null>; blocks: readonly FooterBlock[]; onClose(): void }) {
  const list = useRef<HTMLDivElement>(null);
  const [byKeyboard] = useState(openedByKeyboard);
  useLayoutEffect(() => {
    if (byKeyboard && list.current) focusableElements(list.current)[0]?.focus({ preventScroll: true });
  }, [byKeyboard]);
  return (
    <Popover anchor={anchor} side="top" align="start" label="More composer controls" className="composer-overflow" onClose={onClose}>
      <div ref={list} className="composer-overflow-list">
        {blocks.map((block) => <span key={block.id} className="composer-block" data-composer-block={block.id}>{block.node}</span>)}
      </div>
    </Popover>
  );
}
