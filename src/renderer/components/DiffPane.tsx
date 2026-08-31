import { useEffect, useState } from "react";
import type { DiffLoadOptions, UiFileDiff } from "../../shared/contracts";
import { DiffView } from "./DiffView";

const HUNK_PAGE = 40;

/** Owns paging for one file's diff so the review and file tabs share it. */
export function DiffPane({ path, mode, loadDiff, onLoaded }: {
  path: string;
  mode: "unified" | "split";
  loadDiff(path: string, options?: DiffLoadOptions): Promise<UiFileDiff>;
  onLoaded?(diff: UiFileDiff): void;
}) {
  const [diff, setDiff] = useState<UiFileDiff>();

  useEffect(() => {
    let cancelled = false;
    setDiff(undefined);
    void loadDiff(path, { hunkLimit: HUNK_PAGE }).then((next) => {
      if (cancelled) return;
      setDiff(next);
      onLoaded?.(next);
    });
    return () => { cancelled = true; };
  // onLoaded is a notification hook; a new callback identity must not refetch.
  }, [loadDiff, path]);

  const loadMore = diff?.truncated && diff.nextHunkOffset !== undefined
    ? () => {
      void loadDiff(path, { hunkOffset: diff.nextHunkOffset, hunkLimit: HUNK_PAGE }).then((next) => {
        setDiff((current) => current
          ? { ...next, hunks: [...current.hunks, ...next.hunks], truncated: next.truncated, nextHunkOffset: next.nextHunkOffset }
          : next);
      });
    }
    : undefined;

  return <DiffView diff={diff} mode={mode} onLoadMore={loadMore} />;
}
