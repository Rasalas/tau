import type { TurnEvents } from "./turn-events.js";
import type { HostEvent, UiMessage, UiToolRun, UiTurnActivityEntry } from "../shared/contracts.js";
import type { ClientTurnLedger } from "./client-turn-ledger.js";
import type { ThreadRuntimeEvent } from "./runtime-types.js";
import type { HostTurnObserverSet } from "./host-extensions.js";
import type { ThreadControls } from "./thread-stop.js";
import type { ThreadRuntime } from "./thread-runtime.js";

interface ActivityToolPosition { entry: UiTurnActivityEntry; tool: number }
const activityPositions = new WeakMap<ThreadRuntime, {
  history: UiTurnActivityEntry[];
  scanned: number;
  tools: Map<string, ActivityToolPosition>;
}>();

/** A restored history replaces the array; new turns append to it. Neither needs a scan per delta. */
function positionsFor(thread: ThreadRuntime) {
  const history = thread.adapterActivity;
  let index = activityPositions.get(thread);
  if (!index || index.history !== history || index.scanned > history.length) {
    index = { history, scanned: 0, tools: new Map() };
    activityPositions.set(thread, index);
  }
  while (index.scanned < history.length) {
    const activity = index.scanned++;
    const entry = history[activity]!;
    entry.tools.forEach((tool, position) => index!.tools.set(tool.id, { entry, tool: position }));
  }
  return index;
}

export interface BackendEventServices {
  clientTurns: ClientTurnLedger;
  emit(event: HostEvent): void;
  log(label: string, detail?: string): void;
  fail(error: unknown, sessionId: string): void;
  turns: TurnEvents;
  /** `unpromptedEnded`: a turn the runtime began itself ended, and its outcome stands for the run's. */
  turnObservers: Pick<HostTurnObserverSet, "toolEnded" | "unpromptedEnded">;
  /** Republishes the thread's shell in the index: title, count, usage. */
  refreshShell(thread: ThreadRuntime, touch: boolean): Promise<void>;
  /** Republishes the goal and the background work the runtime holds now. */
  controls: Pick<ThreadControls, "publishGoal" | "publishBackground">;
}

/**
 * Translates what a streamed external backend reports into the host event
 * stream, with the same bookkeeping the Pi path does: tool ownership for
 * output batching, `toolEnded` for turn observers, live turn state for a thread
 * opened mid-turn, and the settled snapshot at the end of a run.
 */
export function handleBackendRuntimeEvent(event: ThreadRuntimeEvent, thread: ThreadRuntime, services: BackendEventServices): void {
  const sessionId = thread.threadId;
  const turns = services.turns;
  switch (event.type) {
    case "context-compaction":
      turns.compaction(thread, sessionId, event.running);
      break;
    case "turn-started":
      thread.unpromptedTurn = event.unprompted === true;
      thread.adapterStreaming = true;
      thread.adapterActivity.push({ id: nextActivityId(thread), tools: [], status: "running" });
      turns.start(thread, sessionId);
      break;
    case "turn-settled":
      settleTurn(event.status, thread, services, event.error, event.limit);
      break;
    case "assistant-start":
      turns.assistant(thread, sessionId, { type: "start", id: event.id, timestamp: event.timestamp });
      break;
    case "assistant-delta":
      turns.assistant(thread, sessionId, { type: "text", id: event.id, delta: event.delta });
      break;
    case "assistant-thinking":
      turns.assistant(thread, sessionId, { type: "thinking", id: event.id, delta: event.delta });
      break;
    case "assistant-end":
      remember(thread, event.message);
      turns.assistant(thread, sessionId, { type: "end", message: event.message });
      break;
    case "user-message":
      remember(thread, event.message);
      services.emit({ type: "user-message", sessionId, message: event.message });
      break;
    case "tool-start":
      recordTool(thread, event.tool);
      saveActivity(thread, services);
      turns.tool(thread, sessionId, thread.cwd, { type: "start", tool: event.tool });
      break;
    case "tool-update": {
      const previous = thread.tools.get(event.id);
      if (previous) {
        const updated = { ...previous, output: event.output };
        recordTool(thread, updated);
      }
      turns.tool(thread, sessionId, thread.cwd, { type: "output", id: event.id, output: event.output });
      break;
    }
    case "tool-end":
      if (event.tool.kind === "subagent") {
        const positions = positionsFor(thread);
        const known = positions.tools.get(event.tool.id);
        const entry = known?.entry ?? currentActivity(thread);
        const at = known?.tool ?? entry.tools.findIndex((tool) => tool.id === event.tool.id);
        if (at === -1) {
          entry.anchorMessageId ??= thread.adapterMessages.at(-1)?.id;
          entry.tools.push(event.tool);
        } else entry.tools[at] = event.tool;
        positions.tools.set(event.tool.id, { entry, tool: at === -1 ? entry.tools.length - 1 : at });
        saveActivity(thread, services, entry);
        services.emit({ type: at === -1 ? "tool-start" : "tool-end", sessionId, tool: event.tool });
      } else finishTool(event.tool, thread, services);
      break;
    case "queue":
      services.emit({ type: "queue", sessionId, steering: [...event.steering], followUp: [...event.followUp] });
      break;
    case "notice":
      // The first error of a running turn is the likeliest cause, for a backend that names none.
      if (event.level === "error" && thread.adapterStreaming) thread.turnError ??= event.message;
      services.emit({ type: "notice", sessionId, message: event.message, level: event.level });
      break;
    case "usage":
    case "title":
      services.refreshShell(thread, false).catch((error) => services.fail(error, sessionId));
      break;
    case "goal":
      services.controls.publishGoal(thread);
      break;
    case "background":
      services.controls.publishBackground(thread);
      break;
    default: {
      const unhandled: never = event;
      services.log("backend.event.unknown", String((unhandled as { type?: unknown }).type));
    }
  }
}

/** Past every number in use: turns a runtime kept may have been thinned out, and ids must stay the ones a client saw. */
function nextActivityId(thread: ThreadRuntime): string {
  const used = thread.adapterActivity.map((entry) => Number(/-(\d+)$/u.exec(entry.id)?.[1] ?? 0));
  return `activity-${thread.threadId}-${Math.max(thread.adapterActivity.length, ...used) + 1}`;
}

/** The turn's activity entry; a tool arriving outside a turn opens one. */
function currentActivity(thread: ThreadRuntime): UiTurnActivityEntry {
  const last = thread.adapterActivity.at(-1);
  if (last?.status === "running") return last;
  const entry: UiTurnActivityEntry = { id: nextActivityId(thread), tools: [], status: "running" };
  thread.adapterActivity.push(entry);
  return entry;
}

/** Keeps the turn's activity entry current; the anchor is the message before its first tool. */
function recordTool(thread: ThreadRuntime, tool: UiToolRun): void {
  const entry = currentActivity(thread);
  if (entry.anchorMessageId === undefined) {
    const anchor = thread.adapterMessages.at(-1)?.id;
    if (anchor) entry.anchorMessageId = anchor;
  }
  const at = entry.tools.findIndex((existing) => existing.id === tool.id);
  if (at === -1) entry.tools.push(tool);
  else entry.tools[at] = tool;
  positionsFor(thread).tools.set(tool.id, { entry, tool: at === -1 ? entry.tools.length - 1 : at });
}

/** Hands the turn's activity to a runtime that keeps it across restarts. */
function saveActivity(thread: ThreadRuntime, services: BackendEventServices, entry = thread.adapterActivity.at(-1)): void {
  const history = thread.backend.capabilities.activityHistory;
  if (!history || !entry) return;
  const copy = { ...entry, tools: entry.tools.map((tool) => ({ ...tool })) };
  Promise.resolve().then(() => history.save(copy))
    .catch((error: unknown) => services.log("activity.save.failed", error instanceof Error ? error.message : String(error)));
}

/** The transcript the host holds for a thread without a journal; a re-sent id replaces its row. */
function remember(thread: ThreadRuntime, message: UiMessage): void {
  const at = thread.adapterMessages.findIndex((existing) => existing.id === message.id);
  thread.adapterMessages = at === -1
    ? [...thread.adapterMessages, message]
    : thread.adapterMessages.map((existing, index) => index === at ? message : existing);
}

function finishTool(tool: UiToolRun, thread: ThreadRuntime, services: BackendEventServices): void {
  const previous = thread.tools.get(tool.id);
  const extras = tool.extras ?? previous?.extras;
  const ended: UiToolRun = { ...tool, ...(extras ? { extras } : {}), args: Object.keys(tool.args).length > 0 ? tool.args : previous?.args ?? {}, startedAt: previous?.startedAt ?? tool.startedAt, endedAt: tool.endedAt ?? Date.now() };
  recordTool(thread, ended);
  saveActivity(thread, services);
  services.turns.tool(thread, thread.threadId, thread.cwd, { type: "end", tool: ended });
}

function settleTurn(status: "completed" | "interrupted" | "error", thread: ThreadRuntime, services: BackendEventServices, failure?: string, limit?: { resetsAt?: number }): void {
  const sessionId = thread.threadId;
  if (thread.isCompacting) services.turns.compaction(thread, sessionId, false);
  // A tool still running when the turn ends never reports again; close its card.
  for (const tool of [...thread.tools.values()]) {
    finishTool({ ...tool, status: "error", output: tool.output ?? (status === "interrupted" ? "Interrupted." : "The turn ended before this tool finished.") }, thread, services);
  }
  thread.adapterStreaming = false;
  const entry = thread.adapterActivity.at(-1);
  if (entry?.status === "running") {
    // A turn without tools leaves no fold behind.
    if (entry.tools.length === 0) thread.adapterActivity.pop();
    else {
      entry.status = status;
      saveActivity(thread, services);
    }
  }
  services.clientTurns.settle(sessionId);
  if (thread.unpromptedTurn) {
    thread.unpromptedTurn = false;
    services.turnObservers.unpromptedEnded(sessionId, status === "error" ? "failed" : "completed");
  }
  const reason = status === "error" ? failure?.trim() || thread.turnError || "The turn failed." : undefined;
  services.turns.settle(thread, sessionId, { snapshot: true, catalog: true, error: reason, ...(reason !== undefined && limit ? { limit } : {}) });
  thread.turnError = undefined;
}
