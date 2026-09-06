import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CLIENT_MESSAGE_MARKER, clientMessageFingerprint } from "../shared/client-message-correlation.js";
import type { TranscriptPage } from "../shared/host-protocol.js";
import { taskProgressHistoryFromMessages } from "../shared/task-progress.js";
import type { HostTranscriptCursor } from "../shared/transcript-cursor.js";
import { ClientTurnLedger } from "./client-turn-ledger.js";
import type { HostThread } from "./host-extensions.js";
import { turnActivityHistoryFromMessages } from "./host-messages.js";
import { localTranscriptPage } from "./host-transcript.js";
import { MISSING_SESSION_FILE, PersistedThreadTranscript } from "./persisted-transcript.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import { ThreadProjection } from "./thread-projection.js";
import { ThreadRuntime } from "./thread-runtime.js";

const SESSION_ID = "child-thread";
const CWD = "/repo";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** Writes one session file the way Pi persists it: a header, then a chain of entries. */
class SessionFixture {
  private readonly lines: string[] = [];
  private parentId: string | null = null;
  private clock = Date.UTC(2026, 0, 1);
  private nextId = 0;

  constructor(sessionId = SESSION_ID, cwd = CWD) {
    this.lines.push(JSON.stringify({
      type: "session", version: 3, id: sessionId, timestamp: new Date(this.clock).toISOString(), cwd,
    }));
  }

  message(role: string, text: string, extra: Record<string, unknown> = {}): string {
    return this.entry({
      type: "message",
      message: { role, content: [{ type: "text", text }], timestamp: this.clock, ...extra },
    });
  }

  /** An assistant entry with no visible text: only a pin keeps it in the transcript. */
  emptyAssistant(): string {
    return this.entry({ type: "message", message: { role: "assistant", content: [], timestamp: this.clock } });
  }

  toolResult(toolCallId: string, output: string): string {
    return this.entry({
      type: "message",
      message: { role: "toolResult", toolCallId, content: [{ type: "text", text: output }], timestamp: this.clock },
    });
  }

  custom(customType: string, data: unknown): string {
    return this.entry({ type: "custom", customType, data });
  }

  private entry(body: Record<string, unknown>): string {
    this.clock += 1_000;
    const id = `entry-${++this.nextId}`;
    this.lines.push(JSON.stringify({
      ...body, id, parentId: this.parentId, timestamp: new Date(this.clock).toISOString(),
    }));
    this.parentId = id;
    return id;
  }

  async write(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "tau-persisted-transcript-"));
    directories.push(directory);
    const path = join(directory, `${SESSION_ID}.jsonl`);
    await writeFile(path, `${this.lines.join("\n")}\n`);
    return path;
  }
}

function persisted(path: string, pins?: (thread: HostThread) => ReadonlySet<string>): PersistedThreadTranscript {
  return new PersistedThreadTranscript(
    { sessionId: SESSION_ID, cwd: CWD, path },
    { runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER, skillCommands: [], ...(pins ? { pins } : {}) },
  );
}

/** A live thread over the very same records, so both paths can be compared. */
function liveThread(entries: readonly unknown[]): ThreadRuntime {
  const backend = {
    kind: "pi" as const,
    runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    threadId: SESSION_ID,
    cwd: CWD,
    capabilities: { journal: { entries: () => entries } },
    composerCommands: () => [],
    state: () => ({ streaming: false, idle: true, hasMessages: true, activeTools: [], supportsImageInput: false, extensionCount: 0 }),
  };
  return new ThreadRuntime(backend as never, { session: { sessionId: SESSION_ID } } as never);
}

function livePage(
  entries: readonly unknown[],
  pins: Set<(thread: HostThread) => Iterable<string>> = new Set(),
  cursor?: HostTranscriptCursor,
): TranscriptPage {
  const thread = liveThread(entries);
  const projection = new ThreadProjection(
    new ClientTurnLedger(),
    () => undefined,
    pins,
    () => ({ sessionId: SESSION_ID, entries: () => thread.entries } as unknown as HostThread),
    (error) => { throw error; },
  );
  const records = projection.branchMessages(thread);
  return localTranscriptPage(
    SESSION_ID,
    projection.messages(thread),
    taskProgressHistoryFromMessages(records),
    turnActivityHistoryFromMessages(records),
    true,
    cursor,
  );
}

function branchOf(path: string): readonly unknown[] {
  return SessionManager.open(path).getBranch();
}

describe("a transcript read from a session file", () => {
  it("pages exactly the way the same thread does while a runtime holds it", async () => {
    const fixture = new SessionFixture();
    for (let turn = 0; turn < 25; turn += 1) {
      fixture.message("user", `Ask ${turn}`);
      fixture.message("assistant", `Answer ${turn}`);
    }
    const path = await fixture.write();
    const entries = branchOf(path);

    const first = persisted(path).page();
    expect(first).toEqual(livePage(entries));
    // 25 turns against a limit of 20: the newest page stops short of the root.
    expect(first.hasMore).toBe(true);
    expect(first.messages.at(0)?.text).toBe("Ask 5");
    expect(first.messages.at(-1)?.text).toBe("Answer 24");

    const older = persisted(path).page(first.olderCursor);
    expect(older).toEqual(livePage(entries, new Set(), first.olderCursor));
    expect(older.hasMore).toBe(false);
    expect(older.messages.at(0)?.text).toBe("Ask 0");
    expect(older.messages.at(-1)?.text).toBe("Answer 4");
  });

  it("keeps a text-empty assistant an extension pinned", async () => {
    const fixture = new SessionFixture();
    fixture.message("user", "Check the worktree");
    const anchor = fixture.emptyAssistant();
    const path = await fixture.write();

    expect(persisted(path).page().messages.map((message) => message.id)).toEqual(["entry-1"]);

    const seen: unknown[] = [];
    const pinned = persisted(path, (thread) => { seen.push(...thread.entries()); return new Set([anchor]); }).page();
    expect(seen).toEqual(branchOf(path));
    expect(pinned.messages.map((message) => message.id)).toEqual(["entry-1", anchor]);
    expect(pinned).toEqual(livePage(branchOf(path), new Set([() => [anchor]])));
  });

  it("correlates a user turn with the client message that sent it", async () => {
    const fixture = new SessionFixture();
    fixture.custom(CLIENT_MESSAGE_MARKER, { clientMessageId: "cm-1", fingerprint: clientMessageFingerprint("Ask once") });
    fixture.message("user", "Ask once");
    fixture.message("assistant", "Answered");
    fixture.message("user", "Ask twice", { clientMessageId: "cm-2" });
    const path = await fixture.write();

    const page = persisted(path).page();
    expect(page.messages.filter((message) => message.role === "user").map((message) => message.clientMessageId))
      .toEqual(["cm-1", "cm-2"]);
    expect(page).toEqual(livePage(branchOf(path)));
  });

  it("answers a missing session file with a reader-facing error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-persisted-transcript-gone-"));
    directories.push(directory);
    expect(() => persisted(join(directory, "nothing.jsonl"))).toThrow(MISSING_SESSION_FILE);
  });

  it("reads a tool result of a thread no runtime holds", async () => {
    const fixture = new SessionFixture();
    fixture.message("user", "Run it");
    fixture.toolResult("call-7", "the whole output");
    const path = await fixture.write();

    expect(persisted(path).toolOutput("call-7")?.output).toBe("the whole output");
    expect(persisted(path).toolOutput("call-9")).toBeUndefined();
  });
});
