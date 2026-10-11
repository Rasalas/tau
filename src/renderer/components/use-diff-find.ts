import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { UiFileDiff } from "../../shared/workspace-kit-types";
import { EMPTY_QUERY, findInDiffs, groupByLine, type DiffFind, type FindMatch, type FindQuery } from "./diff-find";

export interface DiffFindController {
  open: boolean;
  query: FindQuery;
  matches: readonly FindMatch[];
  /** Position of the active match; -1 without one. */
  index: number;
  invalid: boolean;
  capped: boolean;
  /** Changes whenever the bar should take the keyboard again. */
  focus: number;
  show(): void;
  close(): void;
  setQuery(patch: Partial<FindQuery>): void;
  step(direction: 1 | -1): void;
  /** For the element that holds the diffs: Cmd+F (Ctrl+F) opens the bar. */
  onKeyDown(event: KeyboardEvent): void;
  /** For the streams, while the bar is open and has matches. */
  find: DiffFind | undefined;
}

/**
 * Find across the diffs of one surface, files that are folded or not on
 * screen included. `onReveal` is told which match is active so the surface
 * can unfold, select or scroll to the file that holds it; the streams
 * scroll to the line themselves.
 */
export function useDiffFind({ diffs, onReveal }: { diffs: readonly UiFileDiff[]; onReveal?(match: FindMatch): void }): DiffFindController {
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState<FindQuery>(EMPTY_QUERY);
  const [position, setPosition] = useState(0);
  const [seek, setSeek] = useState(0);
  const [focus, setFocus] = useState(0);
  const deferred = useDeferredValue(query);
  const result = useMemo(() => open ? findInDiffs(diffs, deferred) : { matches: [] as FindMatch[] }, [open, diffs, deferred]);
  const { matches } = result;
  const index = matches.length === 0 ? -1 : Math.min(position, matches.length - 1);
  const active = index < 0 ? undefined : matches[index];

  const reveal = useRef(onReveal);
  reveal.current = onReveal;
  useEffect(() => { if (active) reveal.current?.(active); }, [active, seek]);

  const show = useCallback(() => { setOpen(true); setFocus((value) => value + 1); }, []);
  const close = useCallback(() => setOpen(false), []);
  const setQuery = useCallback((patch: Partial<FindQuery>) => {
    setQueryState((current) => ({ ...current, ...patch }));
    setPosition(0);
    setSeek((value) => value + 1);
  }, []);
  const step = useCallback((direction: 1 | -1) => {
    setPosition((current) => matches.length === 0 ? 0 : (Math.min(current, matches.length - 1) + direction + matches.length) % matches.length);
    setSeek((value) => value + 1);
  }, [matches.length]);
  const onKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f") return;
    event.preventDefault();
    event.stopPropagation();
    show();
  }, [show]);

  const byLine = useMemo(() => groupByLine(matches), [matches]);
  const find = useMemo<DiffFind | undefined>(() => open && matches.length > 0 ? { byLine, ...(active ? { active } : {}), seek } : undefined, [active, byLine, matches.length, open, seek]);

  return { open, query, matches, index, invalid: result.invalid === true, capped: result.capped === true, focus, show, close, setQuery, step, onKeyDown, find };
}
