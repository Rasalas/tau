import { Profiler, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ProfilerOnRenderCallback } from "react";
import type { UiMessage, UiToolRun } from "../shared/contracts";
import type { UiFileDiff } from "../shared/workspace-kit-types";
import { DiffView } from "./components/DiffView";
import * as markdownModule from "./components/Markdown";
import { Message } from "./components/Message";
import { ToolRun } from "./components/ToolRun";
import { TranscriptViewport } from "./components/TranscriptViewport";
import type { TranscriptActivity } from "./components/transcript-activity";
import { VirtualTranscript } from "./components/VirtualTranscript";
import { VirtualList } from "./components/VirtualList";
import { ExtensionRegistry } from "./extension-system";
import AppToolStreamScenario from "./RendererBenchmarkApp";
import "./renderer-benchmark.css";

/**
 * Just enough of a live transcript index to drive the streaming scenario:
 * one message updated by ID each frame, with the two revision counters
 * `TranscriptViewport` renders from. The full `TranscriptMessageIndex` (with
 * token/user-revision bookkeeping) lived in shared/ for this one caller;
 * moved here since nothing else used it.
 */
class BenchmarkTranscriptIndex {
  private readonly positions = new Map<string, number>();
  private revisionValue = 0;
  private lookupRevisionValue = 0;

  constructor(private records: UiMessage[]) {
    records.forEach((record, index) => this.positions.set(record.id, index));
  }

  get messages(): UiMessage[] { return this.records; }
  get revision(): number { return this.revisionValue; }
  get lookupRevision(): number { return this.lookupRevisionValue; }

  update(id: string, updater: (message: UiMessage) => UiMessage | undefined): void {
    const index = this.positions.get(id);
    if (index === undefined) return;
    const current = this.records[index]!;
    const next = updater(current);
    if (!next || next === current) return;
    this.records[index] = next;
    if (current.role === "user" || next.role === "user") this.lookupRevisionValue += 1;
    this.revisionValue += 1;
  }
}

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
  longMessageInteraction?: { mode: "expand" | "prop-update"; expanded: boolean; contentBytes: number };
  /** Streaming flips off after the last delta: commit, first painted frame, and deferred work done. */
  streamEnd?: { commitMs: number; paintMs: number; settleMs: number; contentBytes: number };
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

// One section of a realistic long answer: prose, a fence with blank lines, a
// table, and a `~~~` fence inside a list. About twenty make 150 KB and stay
// inside the DOM budget once highlighted.
function fencedSection(index: number): string {
  const prose = (topic: string) => `${topic} for step ${index} walks through the change in plain words, names the files it touches, and says why the order matters. It mentions \`inline code\`, **emphasis**, and a link to https://example.com/steps/${index} so inline parsing has work to do. `.repeat(3).trim();
  const code = Array.from({ length: 36 }, (_, line) => {
    if (line % 9 === 8) return "";
    if (line % 4 === 0) return `  const entry${line} = registry.get("step-${index}-${line}") ?? fallback(${line}); // keep order`;
    return `  notes.push("step ${index}, entry ${line}: the registry is read once per call, so later entries keep their order");`;
  }).join("\n");
  return [
    `## Step ${index}`,
    "",
    prose("The overview"),
    "",
    prose("The detail"),
    "",
    "```typescript",
    `export function step${index}(registry: Map<string, number>, notes: string[]): number {`,
    code,
    `  return registry.size + ${index};`,
    "}",
    "```",
    "",
    prose("The follow-up"),
    "",
    "| Field | Type | Notes |",
    "| --- | --- | --- |",
    `| id | string | stable across step ${index} |`,
    `| count | number | ${index * 3} entries |`,
    "| ready | boolean | `true` once the fence closes |",
    "",
    "- Run the step:",
    "",
    "  ~~~bash",
    `  npm run step -- --index ${index}`,
    "  ~~~",
    "- Check the output.",
    "",
    prose("The summary"),
    "",
    "",
  ].join("\n");
}

function fencedDocument(targetBytes: number): string {
  let text = "";
  for (let index = 0; text.length < targetBytes; index += 1) text += fencedSection(index);
  return text;
}

/** Deferred highlighting the Markdown module still owes, when it reports any. */
function pendingMarkdownWork(): number {
  return (markdownModule as { pendingHighlightCount?: () => number }).pendingHighlightCount?.() ?? 0;
}

function makeTranscript(turns: number): UiMessage[] {
  return Array.from({ length: turns }, (_, index) => ({
    id: `turn-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text: `Turn ${index}\n\nA stable benchmark message with enough content to exercise variable row measurement.`,
    timestamp: index,
  }));
}

function StreamingTranscriptScenario({
  activities,
  onTick,
}: {
  activities: readonly TranscriptActivity[];
  onTick(tick: number): void;
}) {
  const indexRef = useRef<BenchmarkTranscriptIndex | undefined>(undefined);
  if (!indexRef.current) indexRef.current = new BenchmarkTranscriptIndex(makeTranscript(1_000));
  const activeMessageId = "turn-999";
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let tick = 0;
    let stopped = false;
    const update = () => {
      if (stopped) return;
      const delta = `\nstreaming delta ${tick}`;
      indexRef.current!.update(activeMessageId, (message) => ({ ...message, text: message.text + delta }));
      onTick(tick);
      tick += 1;
      if (tick < 36) requestAnimationFrame(update);
    };
    requestAnimationFrame(update);
    return () => { stopped = true; };
  }, [onTick]);

  const messages = indexRef.current.messages;
  const anchor = messages[8];
  return <TranscriptViewport
    messages={messages}
    scrollRef={scrollRef}
    sessionId="renderer-benchmark"
    revision={indexRef.current.revision}
    lookupRevision={indexRef.current.lookupRevision}
    turnStart={anchor ? {
      turnId: "benchmark-streaming-turn",
      sessionId: "renderer-benchmark",
      messageId: anchor.id,
      text: anchor.text,
      timestamp: anchor.timestamp,
    } : undefined}
    isStreaming
    activities={activities}
    liveStatus={<div className="live-status">Streaming current turn</div>}
  />;
}

// A real multi-megabyte patch is tens of thousands of ordinary lines, not a
// thousand pathological ones. Row count is what the diff window has to absorb.
const DIFF_LINE_WIDTH = 96;
const DIFF_LINE_JSON_OVERHEAD = 40;

function makeDiff(targetBytes: number): UiFileDiff {
  const lines: UiFileDiff["hunks"][number]["lines"] = [];
  for (let index = 0, bytes = 0; bytes < targetBytes; index += 1) {
    const text = `const value${index} = ${"benchmarkDiffValue".repeat(6).slice(0, DIFF_LINE_WIDTH)}; // row ${index}`;
    lines.push({
      kind: index % 3 === 0 ? "added" : index % 3 === 1 ? "removed" : "context",
      oldLine: index % 3 === 0 ? undefined : index + 1,
      newLine: index % 3 === 1 ? undefined : index + 1,
      text,
    });
    bytes += text.length + DIFF_LINE_JSON_OVERHEAD;
  }
  return {
    path: "benchmark.ts",
    added: lines.filter((line) => line.kind === "added").length,
    removed: lines.filter((line) => line.kind === "removed").length,
    hunks: [{ header: `@@ -1,${lines.length} +1,${lines.length} @@`, lines }],
    truncated: true,
    nextHunkOffset: 1,
  };
}

function makeLongUserMessage(bytes: number, revision: number): UiMessage {
  return { id: "benchmark-long-user-message", role: "user", text: `${"x".repeat(bytes)}${revision}`, timestamp: revision };
}

export default function RendererBenchmark() {
  const params = new URLSearchParams(window.location.search);
  const scenario = params.get("scenario") ?? "markdown-code-stream-150kb";
  const scenarioConfig = JSON.parse(params.get("config") ?? "{}") as { bytes?: number; turns?: number; items?: number; streamEnd?: boolean; updates?: number; linesPerUpdate?: number };
  const targetBytes = scenarioConfig.bytes ?? 0;
  const fenced = scenario.includes("fenced");
  const fencedText = useMemo(() => fenced ? fencedDocument(targetBytes) : "", [fenced, targetBytes]);
  const [text, setText] = useState(() => scenario.includes("code") ? "```typescript\n" : "");
  const [streaming, setStreaming] = useState(true);
  const streamEnd = useRef<BenchmarkResult["streamEnd"]>(undefined);
  const streamEndStartedAt = useRef<number | undefined>(undefined);
  const [toolOutput, setToolOutput] = useState("");
  const [streamingTick, setStreamingTick] = useState(0);
  const [listQuery, setListQuery] = useState("");
  const mountDurations = useRef<number[]>([]);
  const updateDurations = useRef<number[]>([]);
  const mountStartedAt = useRef(performance.now());
  const updateStartedAt = useRef<number | undefined>(undefined);
  const interactionStartedAt = useRef<number | undefined>(undefined);
  const profilerReportedMount = useRef(false);
  const profilerReportedUpdate = useRef(false);
  const frames = useRef<number[]>([]);
  const finishRef = useRef<(() => void) | undefined>(undefined);
  const [benchmarkPulse, setBenchmarkPulse] = useState(0);
  const [longUserRevision, setLongUserRevision] = useState(0);
  const payloadBytes = useRef(0);
  const longMessageInteraction = useRef<BenchmarkResult["longMessageInteraction"]>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const registry = useMemo(() => new ExtensionRegistry(), []);
  const transcript = useMemo(() => (
    scenario === "transcript-1000-turns"
      || scenario === "transcript-legacy-comparison-1000-turns"
      || scenario === "transcript-viewport-anchored-1000-turns"
      || scenario === "transcript-viewport-streaming-1000-turns"
      ? makeTranscript(1_000)
      : []
  ), [scenario]);
  const transcriptTurn = transcript[8];
  const transcriptActivities = useMemo<readonly TranscriptActivity[]>(() => scenario === "transcript-legacy-comparison-1000-turns"
    || scenario === "transcript-viewport-anchored-1000-turns"
    || scenario === "transcript-viewport-streaming-1000-turns"
    ? transcript.slice(0, 128).map((message, index) => ({
      id: `benchmark-activity-${index}`,
      afterMessageId: message.id,
      content: <span>Activity {index}</span>,
    }))
    : [], [scenario, transcript]);
  const listItems = useMemo(
    () => scenario.endsWith("-10000") ? Array.from({ length: scenarioConfig.items ?? 0 }, (_, index) => `Benchmark item ${index}`) : [],
    [scenario, scenarioConfig.items],
  );
  const filteredListItems = useMemo(() => listItems.filter((item) => item.includes(listQuery)), [listItems, listQuery]);
  const diff = useMemo(() => scenario === "diff-2mb" ? makeDiff(targetBytes) : undefined, [scenario, targetBytes]);
  const longUserMessage = useMemo(() => scenario === "long-user-message" ? makeLongUserMessage(targetBytes, longUserRevision) : undefined, [scenario, targetBytes, longUserRevision]);
  const tool = useMemo<UiToolRun>(() => ({ id: "benchmark-tool", name: "bash", args: { command: "benchmark" }, output: toolOutput, status: "running", startedAt: 0 }), [toolOutput]);
  const onRender: ProfilerOnRenderCallback = (_id, phase, actualDuration) => {
    if (phase === "mount") {
      profilerReportedMount.current = true;
      mountDurations.current.push(actualDuration);
    } else if (actualDuration > 0) {
      profilerReportedUpdate.current = true;
      updateDurations.current.push(actualDuration);
    }
  };
  // Fixture construction is setup, not renderer commit work. Start timing only
  // after the scenario-specific input exists, matching production data flow.
  const onStreamingTick = useCallback((tick: number) => {
    updateStartedAt.current = performance.now();
    setStreamingTick(tick);
  }, []);

  // Bootstrap and the first paint of the workbench are setup; the timed window
  // is the stream alone.
  const onAppStreamReady = useCallback(() => {
    interactionStartedAt.current = performance.now();
    frames.current = [];
  }, []);
  const onAppStreamUpdate = useCallback((duration: number) => { updateDurations.current.push(duration); }, []);
  const onAppStreamFinished = useCallback(() => finishRef.current?.(), []);

  useLayoutEffect(() => {
    if (profilerReportedUpdate.current || updateStartedAt.current === undefined) return;
    const duration = performance.now() - updateStartedAt.current;
    if (duration > 0) updateDurations.current.push(duration);
  }, [listQuery, streamingTick, text, toolOutput]);

  useLayoutEffect(() => {
    if (streaming || streamEndStartedAt.current === undefined) return;
    const commitMs = performance.now() - streamEndStartedAt.current;
    if (!profilerReportedUpdate.current) updateDurations.current.push(commitMs);
    streamEnd.current = { commitMs, paintMs: 0, settleMs: 0, contentBytes: 0 };
  }, [streaming]);

  useEffect(() => {
    // Production React may omit Profiler callbacks. Keep the same commit
    // boundary in that mode while retaining the Profiler instrumentation.
    if (!profilerReportedMount.current && mountDurations.current.length === 0) {
      mountDurations.current.push(performance.now() - mountStartedAt.current);
    }
  }, []);

  useEffect(() => {
    if (profilerReportedUpdate.current || updateStartedAt.current === undefined) return;
    const duration = performance.now() - updateStartedAt.current;
    if (duration > 0) updateDurations.current.push(duration);
  }, [listQuery, text, toolOutput, benchmarkPulse, longUserRevision]);

  useEffect(() => {
    // Sizing the fixture payload is harness instrumentation, not renderer work,
    // so it stays outside the profiled render and the interaction window.
    if (diff) payloadBytes.current = new TextEncoder().encode(JSON.stringify(diff)).byteLength;
    // Mark the interaction before any scheduled task can execute. This keeps
    // the first scenario update out of startup Long Task measurements.
    interactionStartedAt.current = performance.now();
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
        // oxlint-disable-next-line eslint/no-underscore-dangle -- __TAU_RENDERER_BENCHMARK__ is a cross-process marker read by scripts/renderer-benchmark-fixture.cjs over CDP.
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
          streamEnd: streamEnd.current,
        };
      };
      requestAnimationFrame(settle);
    };

    if (fenced) {
      // Deltas of a fixed size cut fences, tables and lists at arbitrary points.
      const deltaBytes = 2_560;
      const endStream = () => {
        streamEndStartedAt.current = performance.now();
        setStreaming(false);
        // The second frame after the commit starts once the first has painted it.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const started = streamEndStartedAt.current!;
          const paintMs = performance.now() - started;
          let waited = 0;
          const settle = () => {
            waited += 1;
            if (pendingMarkdownWork() > 0 && waited < 240) { requestAnimationFrame(settle); return; }
            const content = document.querySelector<HTMLElement>(".message-text");
            streamEnd.current = {
              commitMs: streamEnd.current?.commitMs ?? paintMs,
              paintMs,
              settleMs: performance.now() - started,
              contentBytes: new TextEncoder().encode(content?.textContent ?? "").byteLength,
            };
            finish();
          };
          settle();
        }));
      };
      const append = () => {
        frame += 1;
        updateStartedAt.current = performance.now();
        interactionStartedAt.current ??= updateStartedAt.current;
        setText(fencedText.slice(0, frame * deltaBytes));
        if (frame * deltaBytes < fencedText.length) requestAnimationFrame(append);
        else if (scenarioConfig.streamEnd) requestAnimationFrame(endStream);
        else finish();
      };
      requestAnimationFrame(append);
    } else if (scenario.startsWith("markdown")) {
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
      interactionStartedAt.current = performance.now();
      requestAnimationFrame(() => {
        updateStartedAt.current = performance.now();
        setLongUserRevision((revision) => revision + 1);
        requestAnimationFrame(() => {
          const button = document.querySelector<HTMLButtonElement>(".message-expand");
          if (!button) {
            const content = document.querySelector<HTMLElement>(".message-text-content") ?? document.body;
            longMessageInteraction.current = {
              mode: "prop-update",
              expanded: false,
              contentBytes: new TextEncoder().encode(content.textContent ?? "").byteLength,
            };
            finish();
            return;
          }
          updateStartedAt.current = performance.now();
          button.click();
          requestAnimationFrame(() => {
            const content = document.querySelector<HTMLElement>(".message-text-content");
            longMessageInteraction.current = {
              mode: "expand",
              expanded: button.getAttribute("aria-expanded") === "true",
              contentBytes: new TextEncoder().encode(content?.textContent ?? "").byteLength,
            };
            finish();
          });
        });
      });
    } else if (scenario === "app-tool-output-stream") {
      // The scenario drives itself and calls back; see RendererBenchmarkApp.
      finishRef.current = finish;
    } else if (scenario === "transcript-viewport-streaming-1000-turns") {
      let settleFrames = 0;
      const waitForStreaming = () => {
        settleFrames += 1;
        if (settleFrames < 48) requestAnimationFrame(waitForStreaming);
        else finish();
      };
      requestAnimationFrame(waitForStreaming);
    } else {
      requestAnimationFrame(() => {
        updateStartedAt.current = performance.now();
        interactionStartedAt.current ??= updateStartedAt.current;
        setBenchmarkPulse((pulse) => pulse + 1);
        finish();
      });
    }
    return () => { stopped = true; longTaskCapture.observer?.disconnect(); };
  }, [diff, fenced, fencedText, scenario, scenarioConfig.streamEnd, targetBytes]);

  let content;
  if (scenario.startsWith("markdown")) {
    const message: UiMessage = { id: "benchmark-message", role: "assistant", text, timestamp: 0 };
    content = <Message message={message} streaming={streaming} />;
  } else if (scenario === "tool-output-1mb") {
    content = <ToolRun tool={tool} registry={registry} />;
  } else if (scenario === "transcript-1000-turns") {
    content = <div className="transcript benchmark-transcript" ref={scrollRef}><div className="transcript-inner">
      <VirtualTranscript messages={transcript} scrollRef={scrollRef} isStreaming={false} />
    </div></div>;
  } else if (scenario === "transcript-legacy-comparison-1000-turns") {
    content = <div className="transcript benchmark-transcript" ref={scrollRef}><div className="transcript-inner">
      <VirtualTranscript
        messages={transcript}
        scrollRef={scrollRef}
        isStreaming={false}
        activities={transcriptActivities}
        activeTurnStartId={transcriptTurn?.id}
      />
    </div></div>;
  } else if (scenario === "transcript-viewport-anchored-1000-turns") {
    content = <TranscriptViewport
      messages={transcript}
      scrollRef={scrollRef}
      sessionId="renderer-benchmark"
      turnStart={transcriptTurn ? {
        turnId: "benchmark-turn",
        sessionId: "renderer-benchmark",
        messageId: transcriptTurn.id,
        text: transcriptTurn.text,
        timestamp: transcriptTurn.timestamp,
      } : undefined}
      isStreaming={false}
      activities={transcriptActivities}
      liveStatus={<div className="live-status">Current turn activity</div>}
    />;
  } else if (scenario === "transcript-viewport-streaming-1000-turns") {
    content = <StreamingTranscriptScenario activities={transcriptActivities} onTick={onStreamingTick} />;
  } else if (scenario === "app-tool-output-stream") {
    content = <AppToolStreamScenario
      updates={scenarioConfig.updates ?? 120}
      linesPerUpdate={scenarioConfig.linesPerUpdate ?? 16}
      onReady={onAppStreamReady}
      onUpdate={onAppStreamUpdate}
      onFinished={onAppStreamFinished}
    />;
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
