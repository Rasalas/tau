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
    const advance = () => {
      const region = scroll.current?.querySelector<HTMLElement>(`[data-path="src/file-${index}.ts"]`);
      if (!region) return;
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
    return () => cancelAnimationFrame(frame);
  }, [files, onFinished]);

  return <div className="benchmark-diff-stack" ref={scroll}>
    <DiffStack files={stackFiles} diffs={diffs} scroll={scroll} layout="unified" wrap />
  </div>;
}
