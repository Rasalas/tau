import { useRef, useState } from "react";
import { ListFilter } from "lucide-react";
import { Popover } from "tau";
import type { CommentFilter } from "./comment-filter.js";

/** "Filter", or "N hidden" while something is held back; the checkboxes stay open for the next one. */
export function CommentFilterMenu({ filter, hidden, onChange }: { filter: CommentFilter; hidden: number; onChange(key: keyof CommentFilter, value: boolean): void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={anchor} type="button" className="text-button pr-filter-button" aria-label="Filter comments" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ListFilter size={12} aria-hidden="true" />{hidden > 0 ? `${hidden} hidden` : "Filter"}
      </button>
      {open ? (
        <Popover anchor={anchor} align="end" label="Filter comments" className="pr-filter-menu" onClose={() => setOpen(false)}>
          <fieldset>
            <legend>Show</legend>
            <label><input type="checkbox" checked={filter.bots} onChange={(event) => onChange("bots", event.target.checked)} /> Bot comments</label>
            <label><input type="checkbox" checked={filter.resolved} onChange={(event) => onChange("resolved", event.target.checked)} /> Resolved or dismissed</label>
          </fieldset>
        </Popover>
      ) : null}
    </>
  );
}

/** Said in place of the list when the filter takes every comment out. */
export function hiddenByFilter(count: number): string {
  return count === 1 ? "The only comment is hidden by the filter." : `All ${count} comments are hidden by the filter.`;
}
