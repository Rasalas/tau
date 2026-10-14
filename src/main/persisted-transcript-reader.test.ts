import { writeFileSync } from "node:fs";
import { parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { testPersistedTranscriptWorker } from "./test-support/persisted-transcript-worker.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hostCursorAtLocalIndex } from "./transcript-cursor.js";
import { PersistedTranscriptReader } from "./persisted-transcript-reader.js";
import { PERSISTED_TRANSCRIPT_CHANGED, PersistedThreadTranscript, type PersistedTranscriptOptions } from "./persisted-transcript.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";

let directory: string;
let workerFixture: Awaited<ReturnType<typeof testPersistedTranscriptWorker>>;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "transcript-reader-"));
  workerFixture = await testPersistedTranscriptWorker();
}, 30_000);
afterAll(async () => {
  await workerFixture.dispose();
  await rm(directory, { recursive: true, force: true });
});
const options = { runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER, skillCommands: [] };

function session(turns: number): string {
  const entries: unknown[] = [{ type: "session", version: 3, id: "thread", cwd: "/repo", timestamp: new Date(0).toISOString() }];
  for (let i = 0; i < turns * 2; i += 1) entries.push({
    type: "message", id: `entry-${i}`, parentId: i ? `entry-${i - 1}` : null,
    timestamp: new Date(i + 1).toISOString(),
    message: { role: i % 2 ? "assistant" : "user", timestamp: i + 1, content: [{ type: "text", text: `Message ${i} ${"x".repeat(1024)}` }] },
  });
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

describe("persisted transcript worker", () => {
  it("ships a worker that does not initialize the runtime SDK barrel", async () => {
    const source = await readFile(workerFixture.url, "utf8");
    expect(/from\s+["']@earendil-works\/pi-coding-agent["']/u.test(source)).toBe(false);
    expect(Buffer.byteLength(source)).toBeLessThan(256 * 1024);
  });

  it("matches the full SDK through branching, compaction, context edits and legacy messages", async () => {
    const path = join(directory, "sdk-semantics.jsonl");
    const base = session(30);
    const timestamp = new Date(1).toISOString();
    const tail = [
      { type: "message", id: "discarded", parentId: "entry-59", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Old branch" }], timestamp: 1 } },
      { type: "context_edit", id: "edit", parentId: "entry-59", timestamp, targetId: "entry-55", replacement: { content: [{ type: "text", text: "Edited context" }] } },
      { type: "compaction", id: "compact", parentId: "edit", timestamp, firstKeptEntryId: "entry-50", summary: "Retained summary", tokensBefore: 42_000 },
      { type: "message", id: "result", parentId: "compact", timestamp, message: { role: "toolResult", toolCallId: "tool", content: [{ type: "text", text: "Full tool output" }], timestamp: 1 } },
      { type: "message", id: "notice", parentId: "result", timestamp, message: { role: "hookMessage", customType: "notice", content: [{ type: "text", text: "Legacy notice" }], display: true, timestamp: 1 } },
    ];
    // Version two preserves stable entry ids but migrates hookMessage to custom.
    const text = base.replace('"version":3', '"version":2') + tail.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    await writeFile(path, text);
    const thread = { sessionId: "thread", cwd: "/repo", path };
    const sdkEntries = SessionManager.inMemory("/repo", undefined, parseSessionEntries(text)).getBranch();
    const oracle = new PersistedThreadTranscript(thread, options, sdkEntries);
    const reader = new PersistedTranscriptReader(workerFixture.url, 64 * 1024 * 1024, 0);
    try {
      const page = await reader.page(thread, options);
      expect(page).toEqual(oracle.page());
      expect(page.messages.some((message) => message.text === "Old branch")).toBe(false);
      expect(page.messages.find((message) => message.compaction)?.compaction?.tokensAfter).toBeGreaterThan(0);
      expect(await reader.toolOutput(thread, options, "tool")).toEqual(oracle.toolOutput("tool"));
      const older = await reader.page(thread, options, page.olderCursor);
      expect(older).toEqual(oracle.page(page.olderCursor));
    } finally { await reader.dispose(); }
  });

  it("shares one cold small snapshot across concurrent reads with distinct cursors", async () => {
    const path = join(directory, "concurrent-small.jsonl");
    await writeFile(path, session(30));
    const reader = new PersistedTranscriptReader(workerFixture.url);
    const thread = { sessionId: "thread", cwd: "/repo", path };
    let calls = 0;
    const pinned = { ...options, pins: () => { calls += 1; return new Set<string>(); } };
    const cursor = hostCursorAtLocalIndex(40);
    try {
      const pages = await Promise.all(Array.from({ length: 20 }, (_, index) => reader.page(thread, pinned, index % 2 ? cursor : undefined)));
      const oracle = new PersistedThreadTranscript(thread, options);
      pages.forEach((page, index) => expect(page).toEqual(oracle.page(index % 2 ? cursor : undefined)));
      expect(calls).toBe(1);
      expect(reader.diagnostics.builds).toBe(1);
      expect(reader.diagnostics.sessions).toBe(1);
      expect(reader.diagnostics.cacheBytes).toBe(Buffer.byteLength(JSON.stringify(oracle.entries)) + Buffer.byteLength(JSON.stringify(oracle.messages())));
    } finally { await reader.dispose(); }
  });

  it("keeps the new file revision when an older read overlaps an external rewrite", async () => {
    const path = join(directory, "concurrent-revision.jsonl");
    await writeFile(path, session(30));
    const reader = new PersistedTranscriptReader(workerFixture.url);
    const thread = { sessionId: "thread", cwd: "/repo", path };
    let calls = 0;
    let newer: Promise<unknown> | undefined;
    const pinned: PersistedTranscriptOptions = { ...options, pins: () => {
      calls += 1;
      if (calls === 1) {
        writeFileSync(path, session(3));
        newer = reader.page(thread, pinned);
      }
      return new Set<string>();
    } };
    try {
      const page = await reader.page(thread, pinned);
      await newer;
      expect(page.messages).toHaveLength(6);
      const builds = reader.diagnostics.builds;
      expect((await reader.page(thread, pinned)).messages).toHaveLength(6);
      expect(reader.diagnostics.builds).toBe(builds);
      expect(reader.diagnostics.sessions).toBe(1);
      const oracle = new PersistedThreadTranscript(thread, options);
      expect(reader.diagnostics.cacheBytes).toBe(Buffer.byteLength(JSON.stringify(oracle.entries)) + Buffer.byteLength(JSON.stringify(oracle.messages())));
    } finally { await reader.dispose(); }
  });

  it("does not publish a small snapshot after disposal during pin preparation", async () => {
    const path = join(directory, "disposed-small.jsonl");
    await writeFile(path, session(3));
    const reader = new PersistedTranscriptReader(workerFixture.url);
    await expect(reader.page({ sessionId: "thread", cwd: "/repo", path }, {
      ...options, pins: () => { void reader.dispose(); return new Set<string>(); },
    })).rejects.toThrow("reader is closed");
    expect(reader.diagnostics.sessions).toBe(0);
    expect(reader.diagnostics.cacheBytes).toBe(0);
    await reader.dispose();
  });

  it("reads bounded small sessions without starting an SDK worker", async () => {
    const path = join(directory, "small.jsonl");
    await writeFile(path, session(100));
    // An unusable worker URL makes accidental worker startup fail this assertion.
    const reader = new PersistedTranscriptReader(pathToFileURL(join(directory, "missing-worker.mjs")));
    const thread = { sessionId: "thread", cwd: "/repo", path };
    try {
      const first = await reader.page(thread, options);
      expect(first).toEqual(new PersistedThreadTranscript(thread, options).page());
      expect(reader.workerStarts).toBe(0);
      expect(reader.diagnostics.builds).toBe(1);
      const mapped = reader.diagnostics.mappedRecords;
      const older = await reader.page(thread, options, first.olderCursor);
      expect(older.messages).toHaveLength(40);
      expect(reader.diagnostics.mappedRecords).toBe(mapped);
      expect(reader.diagnostics.builds).toBe(1);
      await writeFile(path, session(2));
      expect((await reader.page(thread, options)).messages).toHaveLength(4);
      expect(reader.diagnostics.builds).toBe(2);
      expect(reader.workerStarts).toBe(0);
    } finally { await reader.dispose(); }
  });

  it("parses off the host loop and indexes repeated pages without remapping history", async () => {
    const path = join(directory, "large.jsonl");
    await writeFile(path, session(4_000));
    const reader = new PersistedTranscriptReader(workerFixture.url);
    const thread = { sessionId: "thread", cwd: "/repo", path };
    try {
      let delivered = false;
      const loading = reader.page(thread, options).then((page) => { delivered = true; return page; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(delivered).toBe(false);
      const first = await loading;
      const mapped = reader.diagnostics.mappedRecords;
      expect(first).toEqual(new PersistedThreadTranscript(thread, options).page());
      for (let i = 0; i < 3; i += 1) {
        const older = await reader.page(thread, options, first.olderCursor);
        expect(older.messages).toHaveLength(40);
        expect(reader.diagnostics.pageRecords).toBe(40);
        expect(reader.diagnostics.mappedRecords).toBe(mapped);
        expect(reader.diagnostics.builds).toBe(1);
      }
      expect(reader.diagnostics.cacheBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
      await writeFile(path, session(2));
      expect((await reader.page(thread, options)).messages).toHaveLength(4);
      expect(reader.diagnostics.builds).toBe(2);
      await rm(path);
      await expect(reader.page(thread, options)).rejects.toThrow("session file is gone");
    } finally { await reader.dispose(); }
  });

  it("retries a changed-file response during cold pin preparation", async () => {
    const path = join(directory, "cold-pins-race.jsonl");
    await writeFile(path, session(1));
    const workerPath = join(directory, "changed-worker.mjs");
    const page = { sessionId: "thread", messages: [], hasMore: false, historyCompleteness: "complete", transcriptWindow: "bounded" };
    await writeFile(workerPath, `
      import { parentPort } from "node:worker_threads";
      let requests = 0;
      parentPort.on("message", (request) => {
        requests += 1;
        if (requests === 1) parentPort.postMessage({ id: request.id, error: ${JSON.stringify(PERSISTED_TRANSCRIPT_CHANGED)} });
        else if (request.operation === "pins") parentPort.postMessage({ id: request.id, value: { entries: [], messages: [], stamp: "snapshot" } });
        else parentPort.postMessage({ id: request.id, value: ${JSON.stringify(page)} });
      });
    `);
    const reader = new PersistedTranscriptReader(pathToFileURL(workerPath), 64 * 1024 * 1024, 0);
    let calls = 0;
    try {
      await expect(reader.page({ sessionId: "thread", cwd: "/repo", path }, {
        ...options, pins: () => { calls += 1; return new Set<string>(); },
      })).resolves.toEqual(page);
      expect(calls).toBe(1);
    } finally { await reader.dispose(); }
  });

  it("retries pins when an external writer changes the file before the page request", async () => {
    const path = join(directory, "pins-race.jsonl");
    await writeFile(path, session(1).replace(/Message 1 x+/u, ""));
    const reader = new PersistedTranscriptReader(workerFixture.url);
    const thread = { sessionId: "thread", cwd: "/repo", path };
    let calls = 0;
    try {
      const page = await reader.page(thread, {
        ...options,
        pins: (snapshot) => {
          calls += 1;
          const id = (snapshot.entries().at(-1) as { id: string }).id;
          if (calls === 1) writeFileSync(path, session(2).replace(/Message 3 x+/u, ""));
          return new Set([id]);
        },
      });
      expect(calls).toBe(2);
      expect(page.messages.map((message) => message.id)).toEqual(["entry-0", "entry-1", "entry-2", "entry-3"]);
    } finally { await reader.dispose(); }
  });

  it("does not retain snapshots larger than the cache budget", async () => {
    const path = join(directory, "oversized.jsonl");
    await writeFile(path, session(2));
    const reader = new PersistedTranscriptReader(workerFixture.url, 1024);
    const thread = { sessionId: "thread", cwd: "/repo", path };
    try {
      expect((await reader.page(thread, options)).messages).toHaveLength(4);
      expect(reader.diagnostics.cacheBytes).toBe(0);
      expect(reader.diagnostics.sessions).toBe(0);
      await reader.page(thread, options);
      expect(reader.diagnostics.builds).toBe(2);
    } finally { await reader.dispose(); }
  });

  it("evaluates pin providers once per file revision and preserves empty rows", async () => {
    const path = join(directory, "pins.jsonl");
    const text = session(1).replace(/Message 1 x+/u, "");
    await writeFile(path, text);
    const reader = new PersistedTranscriptReader(workerFixture.url);
    const thread = { sessionId: "thread", cwd: "/repo", path };
    let calls = 0;
    const pinned = { ...options, pins: () => { calls += 1; return new Set(["entry-1"]); } };
    try {
      expect((await reader.page(thread, pinned)).messages).toHaveLength(2);
      const builds = reader.diagnostics.builds;
      await reader.page(thread, pinned);
      expect(calls).toBe(1);
      expect(reader.diagnostics.builds).toBe(builds);
      await reader.page(thread, { ...pinned, pinsRevision: 1 });
      expect(calls).toBe(2);
    } finally { await reader.dispose(); }
  });
});
