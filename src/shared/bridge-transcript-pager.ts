import { pageRecords, type BoundedTranscriptPage } from "./transcript-pager.js";
import type { UiToolRun, UiTurnActivityEntry } from "./contracts.js";

export const BRIDGE_MAX_TRANSCRIPT_TURNS = 40;
export const BRIDGE_MAX_TRANSCRIPT_RECORDS = 160;
/** Leave room for the bridge frame envelope and snapshot metadata. */
export const BRIDGE_MAX_TRANSCRIPT_BYTES = 6 * 1024 * 1024;
export const BRIDGE_MAX_RECORD_BYTES = 256 * 1024;
/** Leave headroom for the bridge frame envelope and required session fields. */
export const BRIDGE_MAX_SNAPSHOT_BYTES = 7 * 1024 * 1024;
/** The visible page and its activity restoration payload share this budget. */
const BRIDGE_MAX_PAGE_SECTION_BYTES = Math.floor(BRIDGE_MAX_TRANSCRIPT_BYTES / 2);

const MAX_STRING_BYTES = 32 * 1024;
// Keep this above the transcript record ceiling. A lower generic array cap
// would silently shorten a page without moving its cursor, skipping records
// on the next request.
const MAX_ARRAY_ITEMS = BRIDGE_MAX_TRANSCRIPT_RECORDS + 1;
const MAX_OBJECT_KEYS = 128;
const MAX_DEPTH = 12;

export interface BridgeTranscriptPage {
  page: BoundedTranscriptPage<unknown>;
  activityMessages: unknown[];
  /** Derived before the raw activity record ceiling is applied. */
  turnActivityHistory: UiTurnActivityEntry[];
  /** False when one or more activity tools exceeded the metadata ceiling. */
  turnActivityHistoryComplete: boolean;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function encodedBytes(value: unknown): number {
  try {
    return byteLength(JSON.stringify(value) ?? "null");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function truncateString(value: string, maxBytes = MAX_STRING_BYTES): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  const text = new TextDecoder().decode(encoded.slice(0, maxBytes));
  return `${text}\n[Bridge value truncated from ${encoded.byteLength} bytes]`;
}

function boundValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return truncateString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH || seen.has(value)) return "[Bridge value truncated]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.slice(0, MAX_ARRAY_ITEMS).map((item) => boundValue(item, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) result.push(`[${value.length - MAX_ARRAY_ITEMS} array items truncated]`);
    return result;
  }
  const result: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [key, item] of entries.slice(0, MAX_OBJECT_KEYS)) result[key] = boundValue(item, depth + 1, seen);
  if (entries.length > MAX_OBJECT_KEYS) result.__tauBridgeTruncated = `${entries.length - MAX_OBJECT_KEYS} object keys truncated`;
  return result;
}

export function boundedBridgeValue<T>(value: T): T {
  return boundValue(value, 0, new WeakSet()) as T;
}

/**
 * Bounds an already-structured bridge payload without allowing optional
 * catalogs/history to consume the frame reserved for the transcript. The
 * transcript pager performs the finer record/byte accounting; this is the
 * final aggregate guard for snapshots and extension-provided metadata.
 */
export function boundedBridgePayload<T>(value: T, maxBytes = BRIDGE_MAX_SNAPSHOT_BYTES): T {
  const bounded = boundedBridgeValue(value);
  if (encodedBytes(bounded) <= maxBytes) return bounded;
  if (!bounded || typeof bounded !== "object" || Array.isArray(bounded)) return bounded;
  const result = { ...(bounded as Record<string, unknown>) };
  // Keep identity, transcript and required catalog shapes first. Derived
  // overlays can be fetched/reconstructed on the next snapshot, but required
  // arrays must remain present because consumers map them unconditionally.
  for (const key of ["taskHistory", "taskProgress", "composerCommands"]) {
    delete result[key];
    if (encodedBytes(result) <= maxBytes) return result as T;
  }
  for (const key of ["allTools", "models", "activeTools", "thinkingLevels"]) {
    const values = result[key];
    if (!Array.isArray(values)) continue;
    // Trim only optional catalog entries while preserving an array and at
    // least one entry for the wire contract.
    result[key] = values.slice(0, Math.max(1, Math.ceil(values.length / 2)));
    if (encodedBytes(result) <= maxBytes) return result as T;
  }
  // A pathological extension can still make the two transcript views larger
  // than the frame after metadata is removed. Drop raw activity before mapped
  // messages so the user-facing anchors survive whenever possible.
  delete result.activityMessages;
  if (encodedBytes(result) <= maxBytes) return result as T;

  // Compact extension-provided top-level fields before touching the required
  // transcript shape. This final pass also covers event/response payloads,
  // whose oversized field is not necessarily named `messages`.
  const required = new Set([
    "sessionId", "sessionFile", "cwd", "messages", "isStreaming", "model",
    "models", "thinkingLevel", "thinkingLevels", "activeTools", "allTools",
    "turnActivityHistory", "turnActivityHistoryComplete",
  ]);
  const optionalKeys = Object.keys(result)
    .filter((key) => !required.has(key))
    .sort((left, right) => encodedBytes(result[right]) - encodedBytes(result[left]));
  for (const key of optionalKeys) {
    result[key] = Array.isArray(result[key]) ? [] : "[Bridge payload field truncated]";
    if (encodedBytes(result) <= maxBytes) return result as T;
  }

  // Keep all protocol arrays present, but progressively shorten their entries
  // so an extension cannot make an unbounded frame or make a caller lose the
  // distinction between an omitted field and an empty catalog.
  for (const key of ["models", "allTools", "activeTools", "thinkingLevels", "messages", "turnActivityHistory"]) {
    const values = result[key];
    if (!Array.isArray(values)) continue;
    while (values.length > 1 && encodedBytes(result) > maxBytes) values.splice(0, Math.ceil(values.length / 2));
    if (encodedBytes(result) <= maxBytes) return result as T;
  }

  // `messages` is required by PiBridgeSnapshot. An empty array is the only
  // shape-preserving fallback when even the minimal protocol envelope is too
  // large; callers can request a fresh bounded page afterwards.
  if (Array.isArray(result.messages)) result.messages = [];
  return result as T;
}

function contentPreview(value: unknown): string {
  if (typeof value === "string") return truncateString(value, 64 * 1024);
  if (!Array.isArray(value)) return "[Bridge content truncated]";
  const text = value.map((part) => {
    if (!part || typeof part !== "object") return "";
    const item = part as { type?: unknown; text?: unknown; thinking?: unknown };
    if (item.type === "text" && typeof item.text === "string") return item.text;
    if (item.type === "thinking" && typeof item.thinking === "string") return item.thinking;
    return "";
  }).filter(Boolean).join("\n");
  return text ? truncateString(text, 64 * 1024) : "[Bridge content truncated]";
}

const BRIDGE_ACTIVITY_TOOL_LIMIT = BRIDGE_MAX_TRANSCRIPT_RECORDS;
const BRIDGE_ACTIVITY_OUTPUT_PREVIEW_BYTES = 8 * 1024;

function activityContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (!part || typeof part !== "object") return "";
    const item = part as { type?: unknown; text?: unknown };
    return item.type === "text" && typeof item.text === "string" ? item.text : "";
  }).filter(Boolean).join("\n");
}

function activityTimestamp(value: Record<string, unknown>, index: number): number {
  return typeof value.timestamp === "number" && Number.isFinite(value.timestamp) ? value.timestamp : index;
}

function activityOutputPreview(output: string): string {
  return truncateString(output, BRIDGE_ACTIVITY_OUTPUT_PREVIEW_BYTES);
}

interface BridgeActivityHistoryResult {
  history: UiTurnActivityEntry[];
  complete: boolean;
}

/**
 * Project the selected raw branch range into typed activity before
 * `activityMessages` is bounded. This keeps a large tool stream from changing
 * the visible count or final status merely because its raw records crossed the
 * transport ceiling.
 */
function activityHistoryForRecords(records: readonly unknown[]): BridgeActivityHistoryResult {
  const history: UiTurnActivityEntry[] = [];
  let active: {
    id: string;
    anchorMessageId?: string;
    tools: UiToolRun[];
    interrupted: boolean;
    error: boolean;
    omittedTools: boolean;
  } | undefined;
  let toolIndexes = new Map<string, number>();
  let complete = true;

  const finish = () => {
    if (!active || active.tools.length === 0) {
      active = undefined;
      toolIndexes = new Map();
      return;
    }
    const hasError = active.error || active.tools.some((tool) => tool.status === "error");
    const hasRunning = active.tools.some((tool) => tool.status === "running");
    history.push({
      id: active.id,
      ...(active.anchorMessageId ? { anchorMessageId: active.anchorMessageId } : {}),
      tools: active.tools,
      status: hasError ? "error" : active.interrupted ? "interrupted" : hasRunning ? "running" : "completed",
    });
    if (active.omittedTools) complete = false;
    active = undefined;
    toolIndexes = new Map();
  };

  records.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const message = raw as Record<string, unknown>;
    const timestamp = activityTimestamp(message, index);
    if (message.role === "user") {
      finish();
      const anchor = typeof message.tauEntryId === "string" ? message.tauEntryId : `user-${index}`;
      active = {
        id: `turn-activity-${anchor}`,
        anchorMessageId: anchor,
        tools: [],
        interrupted: false,
        error: false,
        omittedTools: false,
      };
      return;
    }
    if (!active) return;
    if (message.stopReason === "aborted" || message.stopReason === "cancelled") active.interrupted = true;
    if (message.stopReason === "error") active.error = true;

    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const rawPart of message.content) {
        if (!rawPart || typeof rawPart !== "object") continue;
        const part = rawPart as Record<string, unknown>;
        if (part.type !== "toolCall" || typeof part.id !== "string" || typeof part.name !== "string") continue;
        active.anchorMessageId ??= typeof message.tauEntryId === "string" ? message.tauEntryId : undefined;
        if (active.tools.length >= BRIDGE_ACTIVITY_TOOL_LIMIT) {
          active.omittedTools = true;
          complete = false;
          continue;
        }
        const tool: UiToolRun = {
          id: part.id,
          name: part.name,
          args: part.arguments && typeof part.arguments === "object" ? part.arguments as Record<string, unknown> : {},
          status: "running",
          startedAt: timestamp,
        };
        toolIndexes.set(part.id, active.tools.length);
        active.tools.push(tool);
      }
    }

    if (message.role !== "toolResult" || typeof message.toolCallId !== "string") return;
    const toolIndex = toolIndexes.get(message.toolCallId);
    if (toolIndex === undefined) return;
    const tool = active.tools[toolIndex];
    const output = activityContentText(message.content);
    const previewTruncated = byteLength(output) > BRIDGE_ACTIVITY_OUTPUT_PREVIEW_BYTES;
    active.tools[toolIndex] = {
      ...tool,
      name: typeof message.toolName === "string" ? message.toolName : tool.name,
      status: message.isError === true ? "error" : "done",
      output: activityOutputPreview(output),
      ...(previewTruncated ? { outputTruncated: true, fullOutputAvailable: true } : {}),
      endedAt: timestamp,
    };
  });
  finish();
  return { history, complete };
}

export function bridgeRecordForTransport(value: unknown): unknown {
  const bounded = boundedBridgeValue(value);
  if (byteLength(JSON.stringify(bounded) ?? "null") <= BRIDGE_MAX_RECORD_BYTES) return bounded;
  if (!value || typeof value !== "object") return "[Bridge record truncated]";
  const item = value as Record<string, unknown>;
  return {
    ...(typeof item.role === "string" ? { role: item.role } : {}),
    ...(typeof item.type === "string" ? { type: item.type } : {}),
    ...(typeof item.tauEntryId === "string" ? { tauEntryId: item.tauEntryId } : {}),
    ...(typeof item.timestamp === "number" ? { timestamp: item.timestamp } : {}),
    ...(typeof item.stopReason === "string" ? { stopReason: item.stopReason } : {}),
    ...(typeof item.customType === "string" ? { customType: item.customType } : {}),
    ...(typeof item.toolCallId === "string" ? { toolCallId: item.toolCallId } : {}),
    ...(typeof item.toolName === "string" ? { toolName: item.toolName } : {}),
    ...(typeof item.isError === "boolean" ? { isError: item.isError } : {}),
    content: contentPreview(item.content),
    __tauBridgeTruncated: `record exceeded ${BRIDGE_MAX_RECORD_BYTES} bytes`,
  };
}

function recordBytes(value: unknown): number {
  return byteLength(JSON.stringify(bridgeRecordForTransport(value)) ?? "null");
}

function isUserRecord(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as { role?: unknown }).role === "user");
}

function isTranscriptRecord(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const role = (value as { role?: unknown }).role;
  return role === "user" || role === "assistant" || role === "custom";
}

function boundedRecords(
  records: readonly unknown[],
  maxBytes = BRIDGE_MAX_TRANSCRIPT_BYTES,
  maxRecords = BRIDGE_MAX_TRANSCRIPT_RECORDS,
): unknown[] {
  const result: unknown[] = [];
  let bytes = 2;
  let omitted = 0;
  for (const record of records) {
    const bounded = bridgeRecordForTransport(record);
    const size = recordBytes(record) + (result.length > 0 ? 1 : 0);
    if (result.length >= maxRecords || bytes + size > maxBytes) {
      omitted += 1;
      continue;
    }
    result.push(bounded);
    bytes += size;
  }
  if (omitted > 0) {
    const marker = { type: "tau-bridge-truncated", omittedRecords: omitted };
    // The marker is useful to the renderer, but it must not push the payload
    // past the shared page budget. Remove the oldest bounded records until it
    // fits; the cursor still describes the transcript page, never this list.
    while (result.length > 0 && bytes + recordBytes(marker) + 1 > maxBytes) {
      const removed = result.shift();
      if (removed !== undefined) {
        bytes -= recordBytes(removed) + (result.length > 0 ? 1 : 0);
        omitted += 1;
      }
    }
    if (bytes + recordBytes(marker) + (result.length > 0 ? 1 : 0) <= maxBytes) result.push({ ...marker, omittedRecords: omitted });
  }
  return result;
}

/** Pages transcript records by user turns, source records and encoded bytes. */
export function bridgeTranscriptPage(records: readonly unknown[], cursor?: string): BridgeTranscriptPage {
  const visibleRecords = records.filter(isTranscriptRecord);
  const rawIndices = records.flatMap((record, index) => isTranscriptRecord(record) ? [index] : []);
  const visibleEnd = cursor === undefined ? visibleRecords.length : Number(cursor);
  const page = pageRecords(
    visibleRecords.map((record, index) => ({ record, index })),
    BRIDGE_MAX_TRANSCRIPT_TURNS,
    cursor,
    (entry) => isUserRecord(entry.record),
    {
      maxRecords: BRIDGE_MAX_TRANSCRIPT_RECORDS,
      // A snapshot carries both the mapped transcript page and raw activity.
      // Reserve half the payload budget for each so the combined frame remains
      // safely below the 8 MiB bridge limit even when the same records appear
      // in both views.
      maxBytes: BRIDGE_MAX_PAGE_SECTION_BYTES,
      measure: (entry) => {
        // Hidden tool records have their own bounded activity payload below.
        // They must not make the visible user/assistant boundary exceed this
        // page's budget: admitting a full user turn is more important than
        // retaining every activity record, and the cursor must still advance
        // over exactly the mapped records that were returned.
        return recordBytes(entry.record);
      },
      // `activityMessages` is bounded independently below. The cursor counts
      // mapped transcript records, so a large hidden tool stream never skips a
      // visible user turn or changes the meaning of the next cursor.
      count: () => 1,
    },
  );
  // Bound visible records with the exact same representation that crosses the
  // bridge. This prevents a large nested assistant message from bypassing the
  // byte accounting used by `pageRecords`.
  const selected = page.messages.map((entry) => bridgeRecordForTransport(entry.record));
  const start = visibleEnd - selected.length;
  const rawStart = rawIndices[start] ?? records.length;
  const rawEnd = rawIndices[visibleEnd] ?? records.length;
  const selectedBytes = selected.reduce<number>((total, entry) => total + recordBytes(entry), 0);
  const activityBudget = Math.max(1, BRIDGE_MAX_TRANSCRIPT_BYTES - selectedBytes - 128);
  const activity = activityHistoryForRecords(records.slice(rawStart, rawEnd));
  return {
    page: { ...page, messages: selected },
    activityMessages: boundedRecords(records.slice(rawStart, rawEnd), activityBudget),
    turnActivityHistory: activity.history,
    turnActivityHistoryComplete: activity.complete,
  };
}
