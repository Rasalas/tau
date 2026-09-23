import { describe, expect, it } from "vitest";
import type { UiToolRun } from "../shared/contracts.js";
import {
  INLINE_TOOL_OUTPUT_CHARS,
  LIVE_TOOL_OUTPUT_CHARS,
  LIVE_TOOL_OUTPUT_MARKER,
  clientToolRun,
  clientTranscript,
  liveToolOutput,
} from "./client-tool-output.js";

const lines = (count: number, width = 40) =>
  Array.from({ length: count }, (_, index) => `${String(index).padStart(6, "0")} ${"x".repeat(width)}`).join("\n");

const tool = (partial: Partial<UiToolRun>): UiToolRun => ({ id: "t1", name: "bash", args: {}, status: "done", startedAt: 0, ...partial });

describe("liveToolOutput", () => {
  it("keeps an output that is short enough to travel with its tool", () => {
    const output = "a".repeat(INLINE_TOOL_OUTPUT_CHARS);
    expect(liveToolOutput(output)).toBe(output);
  });

  it("sends a longer one as its tail from a line start, behind a marker", () => {
    const output = lines(2_000);
    const live = liveToolOutput(output);
    expect(live.startsWith(LIVE_TOOL_OUTPUT_MARKER)).toBe(true);
    const tail = live.slice(LIVE_TOOL_OUTPUT_MARKER.length);
    expect(tail.length).toBeLessThanOrEqual(LIVE_TOOL_OUTPUT_CHARS);
    expect(output.endsWith(tail)).toBe(true);
    expect(output[output.length - tail.length - 1]).toBe("\n");
    expect(liveToolOutput(live)).toBe(live);
  });

  it("does not start the tail inside a surrogate pair", () => {
    const output = "😀".repeat(INLINE_TOOL_OUTPUT_CHARS);
    const tail = liveToolOutput(output).slice(LIVE_TOOL_OUTPUT_MARKER.length);
    expect(tail.codePointAt(0)).toBe("😀".codePointAt(0));
  });
});

describe("clientToolRun", () => {
  it("leaves a small settled output and a tool without output alone", () => {
    const small = tool({ output: "ok" });
    expect(clientToolRun(small)).toBe(small);
    const none = tool({});
    expect(clientToolRun(none)).toBe(none);
  });

  it("holds a large settled output back and says how long it is", () => {
    const output = lines(1_000);
    expect(clientToolRun(tool({ output, outputTruncated: true, fullOutputAvailable: true }))).toEqual({
      id: "t1", name: "bash", args: {}, status: "done", startedAt: 0,
      outputTruncated: true, fullOutputAvailable: true, outputDeferred: true, outputLength: output.length,
    });
    expect(clientToolRun(tool({ output, status: "error" })).outputDeferred).toBe(true);
  });

  it("gives a running tool its live tail", () => {
    const output = lines(1_000);
    expect(clientToolRun(tool({ status: "running", output })).output).toBe(liveToolOutput(output));
  });
});

describe("clientTranscript", () => {
  it("shapes every tool of a detail and returns the same object when nothing changes", () => {
    const small = { tools: [tool({ output: "ok" })], anchorMessageId: "m1" };
    const detail = { sessionId: "s", turnActivity: small, turnActivityHistory: [{ ...small, id: "a1", status: "completed" as const }] };
    expect(clientTranscript(detail)).toBe(detail);
    const big = tool({ output: lines(1_000) });
    const shaped = clientTranscript({ ...detail, turnActivity: { tools: [big] }, turnActivityHistory: [{ id: "a1", status: "completed", tools: [big] }] });
    expect(shaped.turnActivity?.tools[0]?.outputDeferred).toBe(true);
    expect(shaped.turnActivityHistory?.[0]?.tools[0]?.outputDeferred).toBe(true);
    expect(big.output).toBeDefined();
  });
});
