import type { UiToolRun, UiTurnActivity, UiTurnActivityEntry } from "../shared/contracts.js";

/** A tool's output up to this many characters travels with it; a longer one loads on request. */
export const INLINE_TOOL_OUTPUT_CHARS = 16 * 1024;
/** How much of a longer running tool's output a client receives: enough for the live tail it shows. */
export const LIVE_TOOL_OUTPUT_CHARS = 4 * 1024;
export const LIVE_TOOL_OUTPUT_MARKER = "[Earlier output is not sent while the tool runs.]\n";

/**
 * A running tool's output as a client sees it: whole while it is short enough
 * to travel with the tool, then its tail from a line start behind a fixed marker.
 */
export function liveToolOutput(output: string): string {
  if (output.length <= INLINE_TOOL_OUTPUT_CHARS) return output;
  let tail = output.slice(output.length - LIVE_TOOL_OUTPUT_CHARS);
  const newline = tail.indexOf("\n");
  if (newline >= 0 && newline < tail.length - 1) tail = tail.slice(newline + 1);
  else if (isLowSurrogate(tail.charCodeAt(0))) tail = tail.slice(1);
  return LIVE_TOOL_OUTPUT_MARKER + tail;
}

/**
 * A tool as clients receive it: a running one with its live tail, a settled
 * one with its output only when that is small, and otherwise with its size.
 */
export function clientToolRun(tool: UiToolRun): UiToolRun {
  if (tool.output === undefined) return tool;
  if (tool.status === "running") {
    const output = liveToolOutput(tool.output);
    return output === tool.output ? tool : { ...tool, output };
  }
  if (tool.output.length <= INLINE_TOOL_OUTPUT_CHARS) return tool;
  const { output, ...rest } = tool;
  return { ...rest, outputDeferred: true, outputLength: output.length };
}

function clientTools<T extends UiTurnActivity>(activity: T): T {
  const tools = activity.tools.map(clientToolRun);
  return tools.every((tool, index) => tool === activity.tools[index]) ? activity : { ...activity, tools };
}

/** A thread detail or transcript page with every tool in the shape clients receive. */
export function clientTranscript<T extends { turnActivity?: UiTurnActivity; turnActivityHistory?: UiTurnActivityEntry[] }>(value: T): T {
  const turnActivity = value.turnActivity && clientTools(value.turnActivity);
  const turnActivityHistory = value.turnActivityHistory?.map(clientTools);
  if (turnActivity === value.turnActivity
    && (turnActivityHistory === undefined || turnActivityHistory.every((entry, index) => entry === value.turnActivityHistory![index]))) return value;
  return {
    ...value,
    ...(turnActivity ? { turnActivity } : {}),
    ...(turnActivityHistory ? { turnActivityHistory } : {}),
  };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
