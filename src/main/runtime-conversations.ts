import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { HostConversationPage, HostConversationServices, HostConversationSummary } from "./host-extension-contracts.js";
import type { TranscriptPage } from "../shared/host-protocol.js";
import { asHostTranscriptCursor, type HostTranscriptCursor } from "../shared/transcript-cursor.js";
import { localTranscriptPage } from "./host-transcript.js";
import { decodeHostCursor } from "./transcript-cursor.js";
import type { RuntimeSwitch, RuntimeSwitches } from "./runtime-switches.js";

type SegmentReader = (thread: { sessionId: string; cwd: string; path: string }, cursor?: HostTranscriptCursor) => Promise<TranscriptPage>;
type Position = { phase: "segment" | "history"; cursor?: HostTranscriptCursor };
const encode = (position: Position): HostTranscriptCursor => asHostTranscriptCursor(JSON.stringify(position));
function decode(cursor?: HostTranscriptCursor): Position {
  if (cursor === undefined) return { phase: "segment" };
  if (cursor.length > 4096) throw new Error("Invalid conversation cursor");
  const value = JSON.parse(cursor) as Position;
  if (!value || (value.phase !== "segment" && value.phase !== "history") || (value.cursor !== undefined && typeof value.cursor !== "string")) throw new Error("Invalid conversation cursor");
  return value;
}

/** The stored conversation and the latest Pi journal, never a runtime or an obsolete alias. */
export class RuntimeConversations implements HostConversationServices {
  constructor(private readonly switches: RuntimeSwitches, private readonly readSegment: SegmentReader) {}

  private async summary(sessionId: string, record: RuntimeSwitch): Promise<HostConversationSummary | undefined> {
    if (!record.deleted && (record.kind !== "pi" || !record.sessionPath)) return undefined;
    const path = record.sessionPath ?? "";
    const info = record.deleted ? undefined : await stat(path).catch(() => undefined);
    const version = createHash("sha256").update(JSON.stringify([
      sessionId, record.kind, record.cwd, record.history, record.offset, path, record.deleted === true,
      info && [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs],
    ])).digest("hex");
    return { sessionId, cwd: record.cwd, path, version,
      modifiedAt: record.history.reduce((latest, message) => Math.max(latest, message.timestamp ?? 0), info?.mtimeMs ?? 0),
      ...(record.deleted ? { deleted: true as const } : {}),
    };
  }

  async list(): Promise<HostConversationSummary[]> {
    const result: HostConversationSummary[] = [];
    for (const [id, record] of this.switches.entries()) {
      const summary = await this.summary(id, record);
      if (summary) result.push(summary);
    }
    return result;
  }

  async page(sessionId: string, version: string, cursor?: HostTranscriptCursor): Promise<HostConversationPage> {
    const record = this.switches.get(sessionId);
    if (!record || record.deleted || record.kind !== "pi" || !record.sessionPath) return { status: "missing" };
    const before = await this.summary(sessionId, record);
    if (before?.version !== version) return { status: "changed" };
    let position: Position;
    try { position = decode(cursor); } catch { return { status: "invalid-cursor" }; }
    let page: TranscriptPage;
    try {
      page = position.phase === "history"
        ? localTranscriptPage(sessionId, record.history, [], [], true, position.cursor)
        : await this.readSegment({ sessionId, cwd: record.cwd, path: record.sessionPath }, position.cursor);
    } catch (error) {
      if (position.cursor !== undefined && error instanceof Error && /cursor/iu.test(error.message)) return { status: "invalid-cursor" };
      throw error;
    }
    const current = this.switches.get(sessionId);
    if (!current || current.deleted) return { status: "missing" };
    if ((await this.summary(sessionId, current))?.version !== version) return { status: "changed" };
    let messages = page.messages;
    let hasOlder = page.hasMore;
    if (position.phase === "segment" && record.offset > 0) {
      const boundary = page.olderCursor ? decodeHostCursor(page.olderCursor) : { kind: "local" as const, index: 0 };
      if (boundary.kind !== "local") throw new Error("A persisted Pi conversation returned a nonlocal cursor.");
      messages = messages.slice(Math.max(0, record.offset - boundary.index));
      hasOlder = page.hasMore && boundary.index > record.offset;
    }
    const olderCursor = hasOlder && page.olderCursor
      ? encode({ phase: position.phase, cursor: page.olderCursor })
      : position.phase === "segment" && record.history.length ? encode({ phase: "history" }) : undefined;
    return { status: "ok", page: { sessionId, messages,
      hasMore: olderCursor !== undefined, ...(olderCursor ? { olderCursor } : {}),
      historyCompleteness: olderCursor ? "has-more" : "complete", transcriptWindow: "bounded",
    } };
  }
}
