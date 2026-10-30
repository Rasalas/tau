import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, getClientStorage } from "tau";
import type { PullRequestFile } from "./protocol.js";
import { viewedFileRange } from "./review-file-interactions.js";

const HIDE_TESTS_KEY = "tau.review.hide-test-files";
const filterListeners = new Set<(value: boolean) => void>();

/** The two request views share a device-local display preference. */
export function useHideReviewTests() {
  const [hidden, setHidden] = useState(() => getClientStorage()?.get(HIDE_TESTS_KEY) === "true");
  useEffect(() => {
    filterListeners.add(setHidden);
    return () => { filterListeners.delete(setHidden); };
  }, []);
  const set = useCallback((value: boolean) => {
    getClientStorage()?.set(HIDE_TESTS_KEY, String(value));
    setHidden(value);
    for (const listener of filterListeners) listener(value);
  }, []);
  return [hidden, set] as const;
}

/** One range operation at a time; each successful write survives a failure elsewhere in the range. */
export function useViewedFileRanges({ request, files, allowed, save, notify }: {
  request: string;
  files: readonly PullRequestFile[];
  allowed: boolean;
  save(path: string, viewed: boolean): Promise<void>;
  notify(message: string, kind: "error"): void;
}) {
  const anchor = useRef<string | undefined>(undefined);
  const operation = useRef<{ request: string } | undefined>(undefined);
  const [pending, setPending] = useState<{ request: string; paths: ReadonlyMap<string, boolean> }>();
  useEffect(() => { anchor.current = undefined; }, [request]);
  const overrides = pending?.request === request ? pending.paths : undefined;
  const isViewed = (file: PullRequestFile) => overrides?.get(file.path) ?? file.viewed === "viewed";

  const toggle = async (file: PullRequestFile, extend: boolean) => {
    if (!allowed || operation.current?.request === request) return;
    const next = !isViewed(file);
    const range = viewedFileRange(files, file.path, extend ? anchor.current : undefined);
    anchor.current = file.path;
    const changes = range.filter((entry) => isViewed(entry) !== next);
    if (!changes.length) return;
    const current = { request };
    operation.current = current;
    setPending({ request, paths: new Map(changes.map((entry) => [entry.path, next])) });
    await Promise.all(changes.map(async (entry) => {
      try { await save(entry.path, next); }
      catch (error) { notify(`Could not update viewed files (${entry.path}): ${errorMessage(error)}`, "error"); }
    }));
    if (operation.current === current) {
      operation.current = undefined;
      setPending(undefined);
    }
  };
  return { isViewed, toggle, busy: Boolean(overrides), pending: overrides };
}
