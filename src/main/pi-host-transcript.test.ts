import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ThreadRuntime } from "./thread-runtime.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";
import { hostCursorAtLocalIndex } from "./transcript-cursor.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { UiSession } from "../shared/contracts.js";
import { testPersistedTranscriptWorker } from "./test-support/persisted-transcript-worker.js";
import { PersistedTranscriptReader } from "./persisted-transcript-reader.js";
import { PiHost } from "./pi-host.js";

const SESSION_ID = "released-thread";

const directories: string[] = [];
const readers: PersistedTranscriptReader[] = [];
let workerFixture: Awaited<ReturnType<typeof testPersistedTranscriptWorker>>;
beforeAll(async () => { workerFixture = await testPersistedTranscriptWorker(); });
afterAll(async () => { await workerFixture.dispose(); });
afterEach(async () => {
  await Promise.all(readers.splice(0).map((reader) => reader.dispose()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** The session file of a thread this run never opened a runtime for. */
async function sessionFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tau-host-transcript-"));
  directories.push(directory);
  const path = join(directory, `${SESSION_ID}.jsonl`);
  const timestamp = new Date(Date.UTC(2026, 0, 1)).toISOString();
  await writeFile(path, [
    JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp, cwd: "/repo" }),
    JSON.stringify({
      type: "message", id: "entry-1", parentId: null, timestamp,
      message: { role: "user", content: [{ type: "text", text: "Report the index" }], timestamp: 1 },
    }),
    JSON.stringify({
      type: "message", id: "entry-2", parentId: "entry-1", timestamp,
      message: { role: "assistant", content: [{ type: "text", text: "Index 3" }], timestamp: 2 },
    }),
    "",
  ].join("\n"));
  return path;
}

function hostWithIndex(sessions: UiSession[]): PiHost {
  const projectHistory = { list: () => [], isHidden: () => false, iconFor: async () => undefined, remember: async () => undefined };
  const host = new PiHost("/repo", () => undefined, projectHistory as never, false, false);
  const reader = new PersistedTranscriptReader(workerFixture.url);
  readers.push(reader);
  (host as unknown as { persistedTranscripts: PersistedTranscriptReader }).persistedTranscripts = reader;
  const index = (host as unknown as { index: { byId(id: string): UiSession | undefined; ready(): Promise<void> } }).index;
  index.byId = (id) => sessions.find((session) => session.id === id);
  // A host past its first scan.
  index.ready = async () => undefined;
  return host;
}

function indexedThread(path: string): UiSession {
  return {
    id: SESSION_ID,
    path,
    title: "Index 3",
    modifiedAt: 0,
    projectPath: "/repo",
    projectName: "repo",
    messageCount: 2,
  };
}

/** Registers a runtime backend of kind `codex` on a host, the way a kit would. */
function backend(host: PiHost, provider: Record<string, unknown>): void {
  const seam = (host as unknown as { seam: { backends: Map<string, unknown> } }).seam;
  seam.backends.set("codex", { kind: "codex", ...provider });
}

describe("the transcript of a thread the host holds no runtime for", () => {
  it("is read from the session file the index names", async () => {
    const path = await sessionFile();
    const page = await hostWithIndex([indexedThread(path)]).loadTranscript(SESSION_ID);

    expect(page.sessionId).toBe(SESSION_ID);
    expect(page.messages.map((message) => message.text)).toEqual(["Report the index", "Index 3"]);
    expect(page.hasMore).toBe(false);
  });

  it("is refused only when nothing persisted answers for the thread", async () => {
    await expect(hostWithIndex([]).loadTranscript(SESSION_ID))
      .rejects.toThrow("That thread is not open any more.");
  });

  it("reads a thread of another backend from the shell that backend keeps", async () => {
    const external = { ...indexedThread(""), backendKind: "codex" as never };
    const host = hostWithIndex([external]);
    let opened = 0;
    backend(host, {
      lookup: async () => ({
        threadId: SESSION_ID, cwd: "/repo", updatedAt: 7,
        messages: [{ role: "user" as const, text: "Report the index" }, { role: "assistant" as const, text: "Index 3" }],
      }),
      open: async () => { opened += 1; throw new Error("no runtime here"); },
    });

    const page = await host.loadTranscript(SESSION_ID);

    expect(page.messages.map((message) => message.text)).toEqual(["Report the index", "Index 3"]);
    expect(page.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(page.hasMore).toBe(false);
    expect(opened).toBe(0);
  });

  it("is refused when the backend of an external thread knows nothing about it", async () => {
    const external = { ...indexedThread(""), backendKind: "codex" as never };
    const host = hostWithIndex([external]);
    backend(host, { lookup: async () => undefined });

    await expect(host.loadTranscript(SESSION_ID)).rejects.toThrow("That thread is not open any more.");
  });
});


it("shares the live index between the original active detail route and the public transcript-page route", async () => {
  const manager = SessionManager.inMemory("/repo");
  for (let i = 0; i < 100; i++) manager.appendMessage({
    role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `Message ${i}` }], timestamp: i,
  } as never);
  const entries = vi.fn(() => manager.getBranch());
  const thread = new ThreadRuntime({
    kind: "pi", threadId: "live", providerSessionId: "live", cwd: "/repo",
    runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    capabilities: { journal: { entries }, tree: { leafEntryId: () => manager.getLeafId() ?? undefined } },
    composerCommands: () => [],
  } as never, { session: { sessionManager: manager } } as never);
  const host = hostWithIndex([]);
  Object.defineProperty(host, "active", { get: () => thread });
  (host as unknown as { threadFor(): ThreadRuntime }).threadFor = () => thread;
  const cursor = hostCursorAtLocalIndex(80);
  const active = await host.getThreadDetail(cursor);
  entries.mockClear();
  expect(await host.loadTranscript("live", cursor)).toEqual(active);
  expect(await host.getThreadDetail(cursor)).toEqual(active);
  expect(active.messages.map((message) => message.text)).toEqual(Array.from({ length: 40 }, (_, i) => `Message ${i + 40}`));
  expect(entries).not.toHaveBeenCalled();
});
