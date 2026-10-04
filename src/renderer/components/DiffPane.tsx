import { useEffect, useRef, useState } from "react";
import type { DiffLoadOptions, UiFileDiff } from "../../shared/workspace-kit-types";
import { DiffStack } from "./DiffStack";

const HUNK_PAGE = 40;

/** Owns paging for one file's diff so the review and file tabs share it. */
export function DiffPane({ path, mode, loadDiff, onLoaded, wrap = true }: {
  path: string;
  mode: "unified" | "split";
  loadDiff(path: string, options?: DiffLoadOptions): Promise<UiFileDiff>;
  onLoaded?(diff: UiFileDiff): void;
  wrap?: boolean;
}) {
  const request = useRef(0);
  const paging = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  const [diff, setDiff] = useState<UiFileDiff>();

  useEffect(() => {
    const currentRequest = ++request.current;
    paging.current = false;
    let cancelled = false;
    setDiff(undefined);
    setError(undefined);
    void loadDiff(path, { hunkLimit: HUNK_PAGE }).then((next) => {
      if (cancelled) return;
      setDiff(next);
      onLoaded?.(next);
    }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load this diff."); });
    return () => { cancelled = true; if (request.current === currentRequest) request.current++; };
  // onLoaded is a notification hook; a new callback identity must not refetch.
  }, [loadDiff, path]);

  const loadMore = diff?.truncated && diff.nextHunkOffset !== undefined
    ? () => {
      if (paging.current) return;
      paging.current = true;
      const currentRequest = request.current;
      void loadDiff(path, { hunkOffset: diff.nextHunkOffset, hunkLimit: HUNK_PAGE }).then((next) => {
        if (request.current !== currentRequest) return;
        setDiff((current) => current
          ? { ...next, hunks: [...current.hunks, ...next.hunks], truncated: next.truncated, nextHunkOffset: next.nextHunkOffset }
          : next);
      }).catch((reason: unknown) => {
        if (request.current === currentRequest) setError(reason instanceof Error ? reason.message : "Could not load more diff hunks.");
      }).finally(() => { if (request.current === currentRequest) paging.current = false; });
    }
    : undefined;

  return <div className="stage-diff-cards" ref={scroll}>
    {error && diff ? <p className="rvd-note-line rvd-error" role="alert">{error}</p> : null}
    <DiffStack files={[{ path, added: diff?.added ?? 0, removed: diff?.removed ?? 0 }]} layout={mode} wrap={wrap}
      diffs={diff ? new Map([[path, diff]]) : undefined} unavailable={diff ? undefined : error} scroll={scroll}
      onLoadMore={loadMore} />
  </div>;
}
