import type { WorkbenchEvents } from "tau";
import type { DailyUsage, PromptInfo } from "./daily.js";

/** A draft's thread gets its id from the host; its first run within this long is the draft's. */
const DRAFT_CLAIM_MS = 15_000;
/** How long a finished run waits for the thread list to report a usage limit. */
const SETTLE_MS = 3_000;

export interface PromptContext extends PromptInfo {
  sessionId?: string;
}

interface ThreadState {
  backendKind?: string;
  limit?: unknown;
}

/**
 * Counts each accepted prompt, and how the runs of threads this window prompted
 * end, so a second window watching the same thread adds nothing.
 */
export function watchUsage(events: WorkbenchEvents, daily: DailyUsage, current: () => PromptContext | undefined,
  now: () => number = Date.now): () => void {
  const prompted = new Map<string, string | undefined>();
  const threads = new Map<string, ThreadState>();
  const ending = new Map<string, ReturnType<typeof setTimeout>>();
  // The run's last answer decides, as on the host: a retry that answers after an error is a success.
  const failed = new Map<string, boolean>();
  let draft: { at: number; backendKind?: string } | undefined;

  const settle = (id: string) => {
    clearTimeout(ending.get(id));
    ending.delete(id);
    const thread = threads.get(id);
    daily.runEnded(thread?.backendKind ?? prompted.get(id), thread?.limit ? "limit" : failed.get(id) ? "error" : "ok");
    prompted.delete(id);
    failed.delete(id);
  };

  const stops = [
    events.on("prompt-accepted", () => {
      const info = current();
      if (!info) return;
      daily.prompt(info);
      if (info.sessionId) prompted.set(info.sessionId, info.backendKind);
      else draft = { at: now(), backendKind: info.backendKind };
    }),
    events.on("agent-status", ({ sessionId, running }) => {
      if (running) {
        if (!prompted.has(sessionId) && draft && now() - draft.at < DRAFT_CLAIM_MS) prompted.set(sessionId, draft.backendKind);
        if (prompted.has(sessionId)) draft = undefined;
        return;
      }
      if (!prompted.has(sessionId) || ending.has(sessionId)) return;
      ending.set(sessionId, setTimeout(() => settle(sessionId), SETTLE_MS));
    }),
    events.on("assistant-end", ({ sessionId, message }) => {
      if (prompted.has(sessionId)) failed.set(sessionId, Boolean(message.error));
    }),
    events.on("thread-index", ({ threadIndex }) => {
      for (const session of threadIndex.sessions) threads.set(session.id, { backendKind: session.backendKind, limit: session.limit });
    }),
  ];
  return () => {
    for (const stop of stops) stop();
    for (const timer of ending.values()) clearTimeout(timer);
  };
}
