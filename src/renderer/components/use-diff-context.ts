import { useCallback, useMemo, useRef, useState } from "react";
import type { UiFileDiff } from "../../shared/workspace-kit-types";
import { errorMessage } from "../../workbench/error-message";
import { expandDiffContext, splitFileText, type DiffGap, type LineRange } from "./diff-context";

interface FileEntry {
  lines?: readonly string[];
  ranges: readonly LineRange[];
  busy?: boolean;
  error?: string;
  /** The first line of the gap whose click failed, so the message sits where the click was. */
  at?: number;
}

type Files = ReadonlyMap<string, FileEntry>;

export interface DiffContext {
  /** The diff with the lines the reader expanded in it, and the file's length once it was read. */
  apply(diff: UiFileDiff): { diff: UiFileDiff; totalLines?: number };
  /** Whether a file's unchanged lines can be read at all. */
  can(path: string): boolean;
  /** Reads the file on the first call and reveals `range` of it. */
  expand(gap: DiffGap, range: LineRange): void;
  state(path: string): { busy?: boolean; error?: string; at?: number } | undefined;
}

const NONE: Files = new Map();

/**
 * Lets a diff of a file the caller cannot get from git (a pull request's)
 * show its unchanged lines: `read` answers the file's text at the diff's
 * head, once per file. Another `scope` (the request, its head commit) starts
 * over. What the reader expanded is kept as line ranges, so a diff that
 * arrives again is expanded the same way.
 */
export function useDiffContext({ read, can, scope }: { read(path: string): Promise<string>; can?(path: string): boolean; scope: string }): DiffContext {
  const [kept, setKept] = useState<{ scope: string; files: Files }>({ scope, files: NONE });
  const files = kept.scope === scope ? kept.files : NONE;
  const live = useRef({ read, can, scope, files });
  live.current = { read, can, scope, files };

  const update = useCallback((forScope: string, path: string, change: (entry: FileEntry) => FileEntry) => {
    if (live.current.scope !== forScope) return;
    setKept((previous) => {
      const base = previous.scope === forScope ? previous.files : NONE;
      return { scope: forScope, files: new Map(base).set(path, change(base.get(path) ?? { ranges: [] })) };
    });
  }, []);

  const expand = useCallback((gap: DiffGap, range: LineRange) => {
    const { scope: forScope, files: current, read: load } = live.current;
    const entry = current.get(gap.path);
    if (entry?.busy) return;
    if (entry?.lines) {
      update(forScope, gap.path, (before) => ({ ...before, ranges: [...before.ranges, range] }));
      return;
    }
    update(forScope, gap.path, (before) => ({ ranges: before.ranges, busy: true }));
    load(gap.path).then(
      (text) => update(forScope, gap.path, (before) => ({ lines: splitFileText(text), ranges: [...before.ranges, range] })),
      (reason: unknown) => update(forScope, gap.path, (before) => ({ ranges: before.ranges, error: errorMessage(reason), at: gap.from })),
    );
  }, [update]);

  return useMemo<DiffContext>(() => ({
    apply: (diff) => {
      const entry = files.get(diff.path);
      if (!entry?.lines) return { diff };
      return { diff: expandDiffContext(diff, entry.lines, entry.ranges), totalLines: entry.lines.length };
    },
    can: (path) => live.current.can?.(path) ?? true,
    expand,
    state: (path) => {
      const entry = files.get(path);
      return entry?.busy || entry?.error ? { ...(entry.busy ? { busy: true } : {}), ...(entry.error ? { error: entry.error, at: entry.at } : {}) } : undefined;
    },
  }), [expand, files]);
}
