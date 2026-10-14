import { useEffect, useMemo, useRef } from "react";
import type { UiFileDiff } from "../shared/workspace-kit-types";
import { DiffStack } from "./components/DiffStack";

export default function DiffStackScenario({ files, lines, onFinished }: { files: number; lines: number; onFinished(visited: number): void }) {
  const scroll = useRef<HTMLDivElement>(null);
  const diffs = useMemo(() => new Map(Array.from({ length: files }, (_, index) => {
    const path = `src/file-${index}.ts`;
    const diff: UiFileDiff = { path, added: lines, removed: 0, hunks: [{ header: `@@ -0,0 +1,${lines} @@`, lines: Array.from({ length: lines }, (unused, line) => ({ kind: "added", newLine: line + 1, text: `export const value${line} = ${index + line};` })) }] };
    return [path, diff];
  })), [files, lines]);
  const stackFiles = useMemo(() => Array.from(diffs.values()), [diffs]);

  useEffect(() => {
    let frame = 0;
    let index = 0;
    let waiting = false;
    const progress = { visited: 0, waiting: false, targetPresent: false, rowsPresent: false };
    const probe = window as typeof window & { __TAU_DIFF_STACK_PROGRESS__?: typeof progress };
    // oxlint-disable-next-line eslint/no-underscore-dangle -- Cross-process diagnostic read by the Electron fixture over CDP.
    probe.__TAU_DIFF_STACK_PROGRESS__ = progress;
    const advance = () => {
      progress.visited = index;
      progress.waiting = waiting;
      const region = scroll.current?.querySelector<HTMLElement>(`[data-path="src/file-${index}.ts"]`);
      progress.targetPresent = !!region;
      progress.rowsPresent = !!region?.querySelector(".diff-row");
      if (!region) { frame = requestAnimationFrame(advance); return; }
      if (!waiting) { region.scrollIntoView({ block: "start" }); waiting = true; }
      if (region.querySelector(".diff-row")) {
        // Let the observer evict the preceding card and paint this one before advancing.
        frame = requestAnimationFrame(() => {
          index += 1;
          waiting = false;
          if (index === files) onFinished(index);
          else frame = requestAnimationFrame(advance);
        });
      } else frame = requestAnimationFrame(advance);
    };
    frame = requestAnimationFrame(advance);
    return () => {
      cancelAnimationFrame(frame);
      // oxlint-disable-next-line eslint/no-underscore-dangle -- Release the cross-process diagnostic when this scenario unmounts.
      delete probe.__TAU_DIFF_STACK_PROGRESS__;
    };
  }, [files, onFinished]);

  return <div className="benchmark-diff-stack" ref={scroll}>
    <DiffStack files={stackFiles} diffs={diffs} scroll={scroll} layout="unified" wrap />
  </div>;
}
