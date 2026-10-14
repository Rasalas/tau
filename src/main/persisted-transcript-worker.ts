import { parentPort, workerData } from "node:worker_threads";
import { statSync } from "node:fs";
import { PersistedThreadTranscript, MISSING_SESSION_FILE, PERSISTED_TRANSCRIPT_CHANGED, type PersistedThreadInfo } from "./persisted-transcript.js";
import type { UiComposerCommand } from "../shared/contracts.js";
import type { AgentRuntimeAdapter } from "./runtime-adapters.js";
import type { HostTranscriptCursor } from "../shared/transcript-cursor.js";

export const PERSISTED_TRANSCRIPT_CACHE_BYTES = 64 * 1024 * 1024;
const cacheLimit: number = workerData?.cacheBytesLimit ?? PERSISTED_TRANSCRIPT_CACHE_BYTES;
const cache = new Map<string, { stamp: string; reader: PersistedThreadTranscript; bytes: number }>();
let cacheBytes = 0;
let builds = 0;
let mappedRecords = 0;

parentPort!.on("message", (request: {
  id: number; thread: PersistedThreadInfo; adapter: AgentRuntimeAdapter;
  skills: UiComposerCommand[]; operation: "page" | "toolOutput" | "pins";
  cursor?: HostTranscriptCursor; toolCallId?: string; pinned?: string[]; expectedStamp?: string;
}) => {
  try {
    let stat;
    try { stat = statSync(request.thread.path); } catch { throw new Error(MISSING_SESSION_FILE); }
    const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (request.expectedStamp !== undefined && request.expectedStamp !== stamp) throw new Error(PERSISTED_TRANSCRIPT_CHANGED);
    const key = JSON.stringify([request.thread, request.adapter, request.skills, request.pinned?.length ? request.pinned : undefined]);
    let found = cache.get(key);
    if (found?.stamp !== stamp) {
      if (found) { cacheBytes -= found.bytes; cache.delete(key); }
      const preparedKey = JSON.stringify([request.thread, request.adapter, request.skills, undefined]);
      const prepared = request.pinned?.length ? cache.get(preparedKey) : undefined;
      const entries = prepared?.stamp === stamp ? prepared.reader.entries : undefined;
      if (entries && prepared) { cache.delete(preparedKey); cacheBytes -= prepared.bytes; }
      const reader = new PersistedThreadTranscript(request.thread, {
        runtimeAdapter: request.adapter, skillCommands: request.skills,
        ...(request.pinned ? { pins: () => new Set(request.pinned) } : {}),
      }, entries);
      mappedRecords += reader.messages().length;
      const after = statSync(request.thread.path);
      if (`${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== stamp) throw new Error(PERSISTED_TRANSCRIPT_CHANGED);
      builds += 1;
      // Charge both raw and projected payloads, including strings such as inline images.
      const bytes = Buffer.byteLength(JSON.stringify(reader.entries)) + Buffer.byteLength(JSON.stringify(reader.messages()));
      found = { reader, bytes, stamp };
      while (cache.size && (cache.size >= 4 || cacheBytes + bytes > cacheLimit)) {
        const oldest = cache.keys().next().value!;
        cacheBytes -= cache.get(oldest)!.bytes;
        cache.delete(oldest);
      }
      if (bytes <= cacheLimit) { cache.set(key, found); cacheBytes += bytes; }
    } else { cache.delete(key); cache.set(key, found); }
    const value = request.operation === "pins" ? { entries: found.reader.entries, messages: found.reader.messages(), stamp }
      : request.operation === "toolOutput" ? found.reader.toolOutput(request.toolCallId!)
      : found.reader.page(request.cursor);
    parentPort!.postMessage({ id: request.id, value, diagnostics: { builds, mappedRecords, pageRecords: request.operation === "page" ? (value as { messages: unknown[] }).messages.length : 0, cacheBytes, sessions: cache.size } });
  } catch (error) {
    parentPort!.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});
