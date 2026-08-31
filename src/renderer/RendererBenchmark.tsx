import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { UiFileDiff, UiMessage, UiToolRun } from "../shared/contracts";
import { DiffView } from "./components/DiffView";
import { Message } from "./components/Message";
import { ToolGroup } from "./components/ToolGroup";
import { VirtualTranscript } from "./components/VirtualTranscript";
import { VirtualList } from "./components/VirtualList";
import { ExtensionRegistry } from "./extension-system";

interface BenchmarkResult {
  frameIntervalsMs: number[];
  longTasksMs: number[];
  longTaskObserverSupported: boolean;
  commitDurationsMs: number[];
  commits: number;
  domNodes: number;
  heapBytes?: number;
}

declare global {
  interface Window { __TAU_RENDERER_BENCHMARK__?: BenchmarkResult; }
}

function codeChunk(index: number): string {
  return Array.from({ length: 48 }, (_, line) => `const value${index}_${line} = ${line}; // streamed benchmark line\n`).join("");
}

function plainChunk(index: number): string {
  return Array.from({ length: 24 }, (_, paragraph) => `Paragraph ${index}_${paragraph} exercises a growing active Markdown response without syntax highlighting.\n\n`).join("");
}

function makeTranscript(turns: number): UiMessage[] {
  return Array.from({ length: turns }, (_, index) => ({
    id: `turn-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text: `Turn ${index}\n\nA stable benchmark message with enough content to exercise variable row measurement.`,
    timestamp: index,
  }));
}

function makeDiff(): UiFileDiff {
  const lines = Array.from({ length: 10_000 }, (_, index) => ({
    kind: index % 3 === 0 ? "added" as const : index % 3 === 1 ? "removed" as const : "context" as const,
    oldLine: index % 3 === 0 ? undefined : index + 1,
    newLine: index % 3 === 1 ? undefined : index + 1,
    text: `benchmark diff line ${index}`,
  }));
  return { path: "benchmark.ts", added: 3_334, removed: 3_333, hunks: [{ header: "@@ -1,10000 +1,10000 @@", lines }], truncated: true, nextHunkOffset: 1 };
}

function makeLongUserMessage(): UiMessage {
  return { id: "benchmark-long-user-message", role: "user", text: "x".repeat(12_000), timestamp: 0 };
}

export default function RendererBenchmark() {
  const params = new URLSearchParams(window.location.search);
  const scenario = params.get("scenario") ?? "markdown-code-stream-150kb";
  const targetBytes = scenario === "tool-output-1mb" ? 1_048_576 : 153_600;
  const [text, setText] = useState(() => scenario.includes("code") ? "```typescript\n" : "");
  const [toolOutput, setToolOutput] = useState("");
  const [listQuery, setListQuery] = useState("");
  const commits = useRef<number[]>([]);
  const frames = useRef<number[]>([]);
  const longTasks = useRef<number[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const registry = useMemo(() => new ExtensionRegistry(), []);
  const transcript = useMemo(() => scenario === "transcript-1000-turns" ? makeTranscript(1_000) : [], [scenario]);
  const listItems = useMemo(
    () => scenario.endsWith("-10000") ? Array.from({ length: 10_000 }, (_, index) => `Benchmark item ${index}`) : [],
    [scenario],
  );
  const filteredListItems = useMemo(() => listItems.filter((item) => item.includes(listQuery)), [listItems, listQuery]);
  const diff = useMemo(() => scenario === "diff-2mb" ? makeDiff() : undefined, [scenario]);
  const longUserMessage = useMemo(() => scenario === "long-user-message" ? makeLongUserMessage() : undefined, [scenario]);
  const tool = useMemo<UiToolRun>(() => ({ id: "benchmark-tool", name: "bash", args: { command: "benchmark" }, output: toolOutput, status: "running", startedAt: 0 }), [toolOutput]);
  // Fixture construction is setup, not renderer commit work. Start timing only
  // after the scenario-specific input exists, matching production data flow.
  const updateStartedAt = useRef(performance.now());

  useLayoutEffect(() => {
    commits.current.push(performance.now() - updateStartedAt.current);
  }, [listQuery, text, toolOutput]);

  useEffect(() => {
    let frame = 0;
    let previous = performance.now();
    let stopped = false;
    const observeFrame = (now: number) => {
      frames.current.push(now - previous);
      previous = now;
      if (!stopped) requestAnimationFrame(observeFrame);
    };
    requestAnimationFrame(observeFrame);
    let longTaskObserverSupported = typeof PerformanceObserver !== "undefined";
    let observer: PerformanceObserver | undefined;
    try {
      observer = new PerformanceObserver((entries) => {
        entries.getEntries().forEach((entry) => longTasks.current.push(entry.duration));
      });
      observer.observe({ type: "longtask", buffered: true });
    } catch {
      longTaskObserverSupported = false;
      observer?.disconnect();
      observer = undefined;
    }

    const finish = () => {
      let settleFrames = 0;
      const settle = () => {
        settleFrames += 1;
        if (settleFrames < 8) { requestAnimationFrame(settle); return; }
        stopped = true;
        observer?.disconnect();
        const memory = performance as Performance & { memory?: { usedJSHeapSize: number } };
        window.__TAU_RENDERER_BENCHMARK__ = {
          frameIntervalsMs: frames.current.slice(2),
          longTasksMs: longTasks.current,
          longTaskObserverSupported,
          commitDurationsMs: commits.current,
          commits: commits.current.length,
          domNodes: document.getElementsByTagName("*").length,
          heapBytes: memory.memory?.usedJSHeapSize,
        };
      };
      requestAnimationFrame(settle);
    };

    if (scenario.startsWith("markdown")) {
      const append = () => {
        const chunk = scenario.includes("code") ? codeChunk(frame) : plainChunk(frame);
        frame += 1;
        updateStartedAt.current = performance.now();
        setText((current) => {
          const remaining = targetBytes - current.length;
          return remaining > 0 ? current + chunk.slice(0, remaining) : current;
        });
        if (frame * chunk.length < targetBytes) requestAnimationFrame(append);
        else finish();
      };
      requestAnimationFrame(append);
    } else if (scenario === "tool-output-1mb") {
      const chunk = "tool output benchmark line\n".repeat(640);
      const append = () => {
        updateStartedAt.current = performance.now();
        setToolOutput((current) => current + chunk.slice(0, targetBytes - current.length));
        frame += 1;
        if (frame * chunk.length < targetBytes) requestAnimationFrame(append);
        else finish();
      };
      requestAnimationFrame(append);
    } else if (scenario.endsWith("-10000")) {
      const queries = ["9", "99", "999", ""];
      const update = () => {
        const query = queries.shift();
        if (query === undefined) { finish(); return; }
        updateStartedAt.current = performance.now();
        setListQuery(query);
        requestAnimationFrame(update);
      };
      requestAnimationFrame(update);
    } else {
      requestAnimationFrame(finish);
    }
    return () => { stopped = true; observer?.disconnect(); };
  }, [scenario, targetBytes]);

  let content;
  if (scenario.startsWith("markdown")) {
    const message: UiMessage = { id: "benchmark-message", role: "assistant", text, timestamp: 0 };
    content = <Message message={message} streaming />;
  } else if (scenario === "tool-output-1mb") {
    content = <ToolGroup tools={[tool]} registry={registry} />;
  } else if (scenario === "transcript-1000-turns") {
    content = <div className="transcript benchmark-transcript" ref={scrollRef}><div className="transcript-inner">
      <VirtualTranscript messages={transcript} scrollRef={scrollRef} isStreaming={false} />
    </div></div>;
  } else if (scenario.endsWith("-10000")) {
    content = <VirtualList
      items={filteredListItems}
      itemHeight={48}
      overscan={6}
      className="benchmark-large-list"
      renderItem={(item) => <div key={item} className="benchmark-list-row">{item}</div>}
    />;
  } else if (scenario === "long-user-message") {
    content = <Message message={longUserMessage!} />;
  } else {
    content = <DiffView diff={diff!} mode="unified" />;
  }

  return <main className="renderer-benchmark">{content}</main>;
}
