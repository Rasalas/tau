import { Profiler, useEffect, useMemo, useRef, useState, type ProfilerOnRenderCallback } from "react";
import type { UiFileDiff, UiMessage, UiToolRun } from "../shared/contracts";
import { DiffView } from "./components/DiffView";
import { Message } from "./components/Message";
import { ToolGroup } from "./components/ToolGroup";
import { VirtualTranscript } from "./components/VirtualTranscript";
import { VirtualList } from "./components/VirtualList";
import { ExtensionRegistry } from "./extension-system";

interface BenchmarkResult {
  ready: true;
  scenario: string;
  frameIntervalsMs: number[];
  longTasksMs: number[];
  startupLongTasksMs: number[];
  longTaskObserverSupported: boolean;
  profilerMountCaptured: boolean;
  mountDurationsMs: number[];
  updateDurationsMs: number[];
  commits: number;
  domNodes: number;
  heapBytes?: number;
  payloadBytes?: number;
  longMessageInteraction?: { toggleFound: boolean; expanded: boolean; contentBytes: number };
}

declare global {
  interface Window { __TAU_RENDERER_BENCHMARK__?: BenchmarkResult; }
}

const longTaskCapture = (() => {
  const entries: Array<{ startTime: number; duration: number }> = [];
  if (typeof PerformanceObserver === "undefined") return { entries, supported: false, observer: undefined };
  try {
    const observer = new PerformanceObserver((entryList) => {
      entryList.getEntries().forEach((entry) => entries.push({ startTime: entry.startTime, duration: entry.duration }));
    });
    // This module is loaded before the benchmark component mounts, so mount
    // work is observed consistently instead of being lost in useEffect setup.
    observer.observe({ type: "longtask", buffered: true });
    return { entries, supported: true, observer };
  } catch {
    return { entries, supported: false, observer: undefined };
  }
})();

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

function makeDiff(targetBytes: number): UiFileDiff {
  const lines: UiFileDiff["hunks"][number]["lines"] = [];
  const payload = () => ({
    path: "benchmark.ts",
    added: lines.filter((line) => line.kind === "added").length,
    removed: lines.filter((line) => line.kind === "removed").length,
    hunks: [{ header: "@@ -1,10000 +1,10000 @@", lines }],
    truncated: true,
    nextHunkOffset: 1,
  });
  const lineBytes = Math.max(180, Math.ceil(targetBytes / 1_000));
  for (let index = 0; index < 1_000; index += 1) {
    const text = `benchmark diff line ${index} ${"x".repeat(lineBytes)}`;
    lines.push({
      kind: index % 3 === 0 ? "added" : index % 3 === 1 ? "removed" : "context",
      oldLine: index % 3 === 0 ? undefined : index + 1,
      newLine: index % 3 === 1 ? undefined : index + 1,
      text,
    });
  }
  return payload();
}

function makeLongUserMessage(bytes: number, revision: number): UiMessage {
  return { id: "benchmark-long-user-message", role: "user", text: `${"x".repeat(bytes)}${revision}`, timestamp: revision };
}

export default function RendererBenchmark() {
  const params = new URLSearchParams(window.location.search);
  const scenario = params.get("scenario") ?? "markdown-code-stream-150kb";
  const scenarioConfig = JSON.parse(params.get("config") ?? "{}") as { bytes?: number; turns?: number; items?: number };
  const targetBytes = scenarioConfig.bytes ?? 0;
  const [text, setText] = useState(() => scenario.includes("code") ? "```typescript\n" : "");
  const [toolOutput, setToolOutput] = useState("");
  const [listQuery, setListQuery] = useState("");
  const mountDurations = useRef<number[]>([]);
  const updateDurations = useRef<number[]>([]);
  const mountStartedAt = useRef(performance.now());
  const updateStartedAt = useRef<number | undefined>(undefined);
  const interactionStartedAt = useRef<number | undefined>(undefined);
  const profilerReportedMount = useRef(false);
  const profilerReportedUpdate = useRef(false);
  const frames = useRef<number[]>([]);
  const [benchmarkPulse, setBenchmarkPulse] = useState(0);
  const [longUserRevision, setLongUserRevision] = useState(0);
  const payloadBytes = useRef(0);
  const longMessageInteraction = useRef<BenchmarkResult["longMessageInteraction"]>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const registry = useMemo(() => new ExtensionRegistry(), []);
  const transcript = useMemo(() => scenario === "transcript-1000-turns" ? makeTranscript(scenarioConfig.turns ?? 0) : [], [scenario, scenarioConfig.turns]);
  const listItems = useMemo(
    () => scenario.endsWith("-10000") ? Array.from({ length: scenarioConfig.items ?? 0 }, (_, index) => `Benchmark item ${index}`) : [],
    [scenario, scenarioConfig.items],
  );
  const filteredListItems = useMemo(() => listItems.filter((item) => item.includes(listQuery)), [listItems, listQuery]);
  const diff = useMemo(() => {
    if (scenario !== "diff-2mb") return undefined;
    const value = makeDiff(targetBytes);
    payloadBytes.current = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    return value;
  }, [scenario, targetBytes]);
  const longUserMessage = useMemo(() => scenario === "long-user-message" ? makeLongUserMessage(targetBytes, longUserRevision) : undefined, [scenario, targetBytes, longUserRevision]);
  const tool = useMemo<UiToolRun>(() => ({ id: "benchmark-tool", name: "bash", args: { command: "benchmark" }, output: toolOutput, status: "running", startedAt: 0 }), [toolOutput]);
  const onRender: ProfilerOnRenderCallback = (_id, phase, actualDuration) => {
    if (phase === "mount") {
      profilerReportedMount.current = true;
      mountDurations.current.push(actualDuration);
    } else {
      profilerReportedUpdate.current = true;
      updateDurations.current.push(actualDuration);
    }
  };

  useEffect(() => {
    // Production React may omit Profiler callbacks. Keep the same commit
    // boundary in that mode while retaining the Profiler instrumentation.
    if (!profilerReportedMount.current && mountDurations.current.length === 0) {
      mountDurations.current.push(performance.now() - mountStartedAt.current);
    }
  }, []);

  useEffect(() => {
    if (profilerReportedUpdate.current || updateStartedAt.current === undefined) return;
    updateDurations.current.push(performance.now() - updateStartedAt.current);
  }, [listQuery, text, toolOutput, benchmarkPulse, longUserRevision]);

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
    const finish = () => {
      let settleFrames = 0;
      const settle = () => {
        settleFrames += 1;
        if (settleFrames < 8) { requestAnimationFrame(settle); return; }
        stopped = true;
        longTaskCapture.observer?.disconnect();
        const memory = performance as Performance & { memory?: { usedJSHeapSize: number } };
        window.__TAU_RENDERER_BENCHMARK__ = {
          ready: true,
          scenario,
          frameIntervalsMs: frames.current.slice(2),
        longTasksMs: longTaskCapture.entries
          .filter((entry) => interactionStartedAt.current !== undefined && entry.startTime >= interactionStartedAt.current)
          .map((entry) => entry.duration),
        startupLongTasksMs: longTaskCapture.entries
          .filter((entry) => interactionStartedAt.current === undefined || entry.startTime < interactionStartedAt.current)
          .map((entry) => entry.duration),
          longTaskObserverSupported: longTaskCapture.supported,
          profilerMountCaptured: mountDurations.current.length > 0,
          mountDurationsMs: mountDurations.current,
          updateDurationsMs: updateDurations.current,
          commits: updateDurations.current.length,
          domNodes: document.getElementsByTagName("*").length,
          heapBytes: memory.memory?.usedJSHeapSize,
          payloadBytes: payloadBytes.current || undefined,
          longMessageInteraction: longMessageInteraction.current,
        };
      };
      requestAnimationFrame(settle);
    };

    if (scenario.startsWith("markdown")) {
      const append = () => {
        const chunk = scenario.includes("code") ? codeChunk(frame) : plainChunk(frame);
        frame += 1;
        updateStartedAt.current = performance.now();
        interactionStartedAt.current ??= updateStartedAt.current;
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
        interactionStartedAt.current ??= updateStartedAt.current;
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
        interactionStartedAt.current ??= updateStartedAt.current;
        setListQuery(query);
        requestAnimationFrame(update);
      };
      requestAnimationFrame(update);
    } else if (scenario === "long-user-message") {
      requestAnimationFrame(() => {
        updateStartedAt.current = performance.now();
        interactionStartedAt.current ??= updateStartedAt.current;
        setLongUserRevision((revision) => revision + 1);
        requestAnimationFrame(() => {
          const button = document.querySelector<HTMLButtonElement>(".message-expand");
          if (!button) throw new Error("long-user-message did not render its expand control");
          updateStartedAt.current = performance.now();
          interactionStartedAt.current ??= updateStartedAt.current;
          button.click();
          requestAnimationFrame(() => {
            const content = document.querySelector<HTMLElement>(".message-text-content");
            longMessageInteraction.current = {
              toggleFound: true,
              expanded: button.getAttribute("aria-expanded") === "true",
              contentBytes: new TextEncoder().encode(content?.textContent ?? "").byteLength,
            };
            finish();
          });
        });
      });
    } else {
      requestAnimationFrame(() => {
        updateStartedAt.current = performance.now();
        interactionStartedAt.current ??= updateStartedAt.current;
        setBenchmarkPulse((pulse) => pulse + 1);
        finish();
      });
    }
    return () => { stopped = true; longTaskCapture.observer?.disconnect(); };
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

  return <main className="renderer-benchmark"><Profiler id={scenario} onRender={onRender}>{content}</Profiler></main>;
}
