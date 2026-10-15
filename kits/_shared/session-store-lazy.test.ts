import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { CodexSessionStore } from "../codex/session-store.js";
import { ClaudeRuntimeSessionStore } from "../claude-code/session-store.js";
import { AntigravitySessionStore } from "../antigravity/session-store.js";
import { CursorSessionStore } from "../cursor/session-store.js";
import { GrokSessionStore } from "../grok/session-store.js";
import { OpenCodeSessionStore } from "../opencode/session-store.js";
import { SessionStorePersistence } from "./session-store-persistence.js";
import { ClaudeUsage, recoverUsageTurns } from "../claude-code/sdk-usage.js";
import { mergeTallies, THREAD_TEXT_CHARS } from "tau/host-extension";

const constructors = [CodexSessionStore, ClaudeRuntimeSessionStore, AntigravitySessionStore, CursorSessionStore, GrokSessionStore, OpenCodeSessionStore];
const cases = constructors.map(Constructor => [Constructor.name, Constructor] as const);
type Store = InstanceType<(typeof constructors)[number]>;
const directories: string[] = [];
const stores: Store[] = [];
const usage = { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 5, costUsd: 0.01, turns: 1 };
const turns = [{ ...usage, at: 2, provider: "fake", model: "first" }, { ...usage, at: 3, provider: "fake", model: "second" }];
const messages = [{ role: "user" as const, text: "title seed", timestamp: 1 }, { role: "assistant" as const, text: "exact reply", timestamp: 2 }];
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.dispose()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
function append(store: Store, id: string, cwd: string, additions: Array<{ role: "user" | "assistant"; text: string; timestamp: number }>): Promise<void> {
  const ui = additions.map(message => ({ ...message, id: `message-${message.timestamp}` }));
  return store instanceof ClaudeRuntimeSessionStore ? store.appendExchange(id, cwd, ui) : store.appendMessages(id, cwd, ui);
}
async function fixture(Constructor: (typeof constructors)[number], selectedInstance?: string, extraThreads = 0) {
  const directory = await mkdtemp(join(tmpdir(), "tau-lazy-store-"));
  directories.push(directory);
  const filePath = join(directory, "sessions.json");
  await writeFile(filePath, JSON.stringify({ version: 1, sessions: ["selected", "unseen", ...Array.from({ length: extraThreads }, (_, index) => `filler-${index}`)].map(tauThreadId => ({ tauThreadId, ...(tauThreadId === "selected" && selectedInstance ? { instance: selectedInstance } : {}), cwd: directory, updatedAt: 2, messages, usage, ...(Constructor === ClaudeRuntimeSessionStore ? { claudeSessionId: "123e4567-e89b-12d3-a456-426614174000" } : {}), ...(Constructor !== OpenCodeSessionStore ? { usageTurns: turns } : {}) })) }));
  const make = () => { const store = new Constructor({ filePath }); stores.push(store); return store; };
  const migrated = make();
  await migrated.listMetadata();
  await migrated.dispose();
  return { directory, filePath, make, databasePath: migrated.databasePath };
}
function poison(db: DatabaseSync, table: string, allowed?: string): void {
  db.exec(`ALTER TABLE ${table} RENAME TO fixture_${table};
    CREATE VIEW ${table} AS SELECT thread_id, ordinal,
      ${allowed ? `CASE WHEN thread_id = '${allowed}' THEN payload ELSE json('poison payload') END` : "json('poison payload')"} AS payload FROM fixture_${table}`);
}
it.each(cases)("%s lists migrated metadata with zero payload reads, then opens only the requested history", async (_name, Constructor) => {
  const { make, databasePath } = await fixture(Constructor);
  const db = new DatabaseSync(databasePath);
  try {
    poison(db, "messages");
    poison(db, "usage_turns");
    const store = make();
    const metadata = await store.listMetadata();
    expect(metadata.map(record => [record.tauThreadId, record.messageCount, record.messages])).toEqual(
      ["selected", "unseen"].map(id => [id, 2, [messages[0]]]));
    if ("talliesOf" in store) {
      expect(store.talliesOf("selected")).toEqual(mergeTallies(turns));
      const tallies = store.talliesOf("selected");
      tallies[0]!.totalTokens = 0;
      expect(store.talliesOf("selected")).toEqual(mergeTallies(turns));
    }
    for (const table of ["messages", "usage_turns"]) db.exec(`DROP VIEW ${table};
      CREATE VIEW ${table} AS SELECT thread_id, ordinal, CASE WHEN thread_id = 'selected' THEN payload ELSE json('poison payload') END AS payload FROM fixture_${table}`);
    const selected = await store.get("selected");
    expect(selected?.messages).toEqual(messages);
    if (selected && "usageTurns" in selected) expect(selected.usageTurns).toEqual(turns);
    expect((await store.listMetadata()).map(record => record.messageCount)).toEqual([2, 2]);
    await expect(store.get("unseen")).rejects.toThrow();
  } finally { db.close(); }
});
it.each(cases)("%s hydrates before a cold metadata mutation, concurrent append, trash restore and reload drain", async (_name, Constructor) => {
  const { make, directory } = await fixture(Constructor);
  const store = make();
  await store.listMetadata();
  await store.setTitle("selected", directory, "renamed", "renamed");
  const additions = [3, 4].map(timestamp => ({ role: "assistant" as const, text: `message ${timestamp}`, timestamp }));
  await Promise.all(additions.map(message => append(store, "selected", directory, [message])));
  const released = store.flushAndRelease();
  const retainedWrite = append(store, "selected", directory, [{ role: "assistant", text: "after release", timestamp: 5 }]);
  await Promise.all([released, retainedWrite]);
  const taken = await store.take("unseen");
  expect(taken?.messages).toEqual(messages);
  await store.put("unseen", taken);
  await store.setTitle("selected", directory, "shutdown", "renamed");
  await store.dispose();
  const reopened = make();
  expect((await reopened.get("selected"))?.messages.map(message => message.text)).toEqual(["title seed", "exact reply", "message 3", "message 4", "after release"]);
  expect((await reopened.get("selected"))?.title).toBe("shutdown");
  expect(await reopened.get("unseen")).toEqual(taken);
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

it.each(["bulk", "selected"] as const)("keeps accepted appends visible when %s hydration starts first", async first => {
  const { make, directory } = await fixture(CodexSessionStore);
  const store = make();
  await store.listMetadata();
  // Gate scheduling only. Reads, writes, revisions and the process lock remain real.
  const persistence = (store as unknown as { persistence: {
    request(operation: string, values?: Record<string, unknown>): Promise<unknown>;
    write(changes: unknown): Promise<void>;
    locked<R>(action: () => Promise<R>): Promise<R>;
  } }).persistence;
  const request = persistence.request.bind(persistence), locked = persistence.locked.bind(persistence);
  const write = persistence.write.bind(persistence);
  const responseReady = gate(), releaseResponse = gate();
  const readerQueued = gate(), releaseReader = gate();
  const writeQueued = gate(), releaseWrite = gate();
  const concurrentFrozen = gate();
  const reads: string[] = [];
  let lockCalls = 0, writeCalls = 0;
  persistence.write = changes => {
    const pending = write(changes);
    if (++writeCalls === 2) concurrentFrozen.release();
    return pending;
  };
  persistence.request = async (operation, values) => {
    const result = await request(operation, values);
    if (operation === "history" || operation === "histories") {
      reads.push(operation);
      if (reads.length === 1) { responseReady.release(); await releaseResponse.promise; }
    }
    return result;
  };
  persistence.locked = async action => {
    const call = ++lockCalls;
    if (call === 2) { readerQueued.release(); await releaseReader.promise; }
    if (call === 3) { writeQueued.release(); await releaseWrite.promise; }
    return locked(action);
  };
  try {
    const initial = first === "bulk" ? store.list() : store.get("selected");
    await responseReady.promise;
    const overlapping = first === "bulk" ? store.get("selected") : store.list();
    if (first === "bulk") await readerQueued.promise;
    releaseResponse.release();
    await initial;
    await readerQueued.promise;
    const accepted = append(store, "selected", directory, [{ role: "assistant", text: "accepted", timestamp: 3 }]);
    await writeQueued.promise; // freeze has published the pending revision, but SQLite still has the old one.
    const concurrent = append(store, "selected", directory, [{ role: "assistant", text: "concurrent", timestamp: 4 }]);
    // Both updates mutate the live record before the queued reader resumes.
    await concurrentFrozen.promise;
    releaseReader.release();
    await overlapping;
    releaseWrite.release();
    await Promise.all([accepted, concurrent]);
    const expected = ["title seed", "exact reply", "accepted", "concurrent"];
    expect((await store.get("selected"))?.messages.map(message => message.text)).toEqual(expected);
    await store.setTitle("selected", directory, "after overlap", "renamed");
    const fresh = await make().get("selected");
    expect(fresh?.messages.map(message => message.text)).toEqual(expected);
    expect(fresh?.title).toBe("after overlap");
    // The queued reader reuses the live object instead of installing a stale database snapshot.
    expect(reads).toEqual(first === "bulk" ? ["histories"] : ["history", "histories"]);
  } finally {
    releaseResponse.release(); releaseReader.release(); releaseWrite.release();
    persistence.request = request;
    persistence.locked = locked;
    persistence.write = write;
  }
});

it.each(["bulk", "selected"] as const)("keeps history available to an append while its %s reader closes", async first => {
  const { make, directory } = await fixture(CodexSessionStore);
  const store = make();
  await store.listMetadata();
  const persistence = (store as unknown as { persistence: {
    request(operation: string, values?: Record<string, unknown>): Promise<unknown>;
    write(changes: unknown): Promise<void>;
    loadSession(id: string): Promise<unknown>;
  } }).persistence;
  const request = persistence.request.bind(persistence), write = persistence.write.bind(persistence);
  const loadSession = persistence.loadSession.bind(persistence);
  const closing = gate(), releaseClose = gate(), frozen = gate(), hydrating = gate();
  persistence.request = async (operation, values) => {
    const result = await request(operation, values);
    if (operation === "close") { closing.release(); await releaseClose.promise; }
    return result;
  };
  persistence.write = changes => { const pending = write(changes); frozen.release(); return pending; };
  try {
    const selected = first === "bulk" ? store.list() : store.get("selected");
    await closing.promise;
    persistence.loadSession = id => { hydrating.release(); return loadSession(id); };
    const accepted = append(store, "selected", directory, [{ role: "assistant", text: "accepted", timestamp: 3 }]);
    // Old code freezes a write from metadata; fixed code joins the pending reader.
    await Promise.race([frozen.promise, hydrating.promise]);
    releaseClose.release();
    await Promise.all([selected, accepted]);
    const expected = ["title seed", "exact reply", "accepted"];
    expect((await make().get("selected"))?.messages.map(message => message.text)).toEqual(expected);
    expect((await store.get("selected"))?.messages.map(message => message.text)).toEqual(expected);
    await store.setTitle("selected", directory, "after close", "renamed");
    const fresh = await make().get("selected");
    expect(fresh?.messages.map(message => message.text)).toEqual(expected);
    expect(fresh?.title).toBe("after close");
  } finally {
    releaseClose.release();
    persistence.request = request; persistence.write = write; persistence.loadSession = loadSession;
  }
});

it.each(["selected", "bulk"] as const)("leaves %s hydration unpublished after a real worker-close error, then retries", async first => {
  const { make } = await fixture(CodexSessionStore);
  const store = make();
  await store.listMetadata();
  const persistence = (store as unknown as { persistence: {
    request(operation: string, values?: Record<string, unknown>): Promise<unknown>;
    isUnloaded(id: string): boolean;
  } }).persistence;
  const request = persistence.request.bind(persistence);
  let fail = true;
  persistence.request = async (operation, values) => {
    const result = await request(operation, values);
    if (operation === "close" && fail) { fail = false; throw new Error("injected reader close error"); }
    return result;
  };
  try {
    await expect(first === "selected" ? store.get("selected") : store.list()).rejects.toThrow("injected reader close error");
    expect(persistence.isUnloaded("selected")).toBe(true);
    expect((await store.listMetadata()).find(record => record.tauThreadId === "selected")?.messages).toEqual([messages[0]]);
    if (first === "bulk") expect((await store.list()).find(record => record.tauThreadId === "selected")?.messages).toEqual(messages);
    expect((await store.get("selected"))?.messages).toEqual(messages);
  } finally { persistence.request = request; }
});

// Trigger a public operation in the first microtask after the real loaded flag clears.
// Standalone readers gain no extra promise hop; overlapping readers gate the worker response.
// SQLite, records, revisions and flags stay real.
it.each(cases.flatMap(([name, Constructor]) => ["selected", "bulk"].flatMap(first =>
  ["append", "take"].flatMap(operation => [false, true].map(overlap => ({ name, Constructor, first, operation, overlap }))))))(
  "$name publishes ownership before $first-first hydration, overlap=$overlap, receives $operation", async ({ Constructor, first, operation, overlap }) => {
    const { make, directory } = await fixture(Constructor);
    const store = make();
    await store.listMetadata();
    const persistence = (store as unknown as { persistence: {
      unloaded: Set<string>;
      request(operation: string, values?: Record<string, unknown>): Promise<unknown>;
    } }).persistence;
    const request = persistence.request.bind(persistence);
    const remove = persistence.unloaded.delete.bind(persistence.unloaded);
    const responseReady = gate(), releaseResponse = gate(), entered = gate();
    let triggered = false;
    let mutation!: Promise<unknown>;
    if (overlap) persistence.request = async (requestOperation, values) => {
      const result = await request(requestOperation, values);
      if (!triggered && (requestOperation === "history" || requestOperation === "histories")) {
        responseReady.release();
        await releaseResponse.promise;
      }
      return result;
    };
    persistence.unloaded.delete = id => {
      const result = remove(id);
      if (id === "selected" && !triggered) {
        triggered = true;
        queueMicrotask(() => {
          mutation = operation === "append"
            ? append(store, id, directory, [{ role: "assistant", text: "accepted", timestamp: 3 }])
            : store.take(id);
          entered.release();
        });
      }
      return result;
    };
    const readers: Promise<unknown>[] = [];
    try {
      readers.push(first === "selected" ? store.get("selected") : store.list());
      if (overlap) {
        await responseReady.promise;
        readers.push(first === "selected" ? store.list() : store.get("selected"));
        releaseResponse.release();
      }
      await entered.promise;
      const taken = await mutation as { messages: typeof messages } | undefined;
      const expected = ["title seed", "exact reply", "accepted"];
      const immediate = await store.get("selected");
      const durable = await make().get("selected");
      if (operation === "append") {
        expect.soft(immediate?.messages.map(message => message.text)).toEqual(expected);
        expect.soft(immediate?.messages).toMatchObject([...messages, { role: "assistant", text: "accepted", timestamp: 3 }]);
        expect.soft(durable?.messages.map(message => message.text)).toEqual(expected);
        expect.soft(durable?.messages).toEqual(immediate?.messages);
      } else {
        expect.soft(taken?.messages).toEqual(messages);
        expect.soft(immediate).toBeUndefined();
        expect.soft(durable).toBeUndefined();
      }
      await Promise.all(readers);
      if (operation === "take") {
        expect(await store.get("selected")).toBeUndefined();
        expect((await store.listMetadata()).some(record => record.tauThreadId === "selected")).toBe(false);
        await store.put("selected", taken);
      }
      await expect(store.setTitle("selected", directory, "after publication", "renamed")).resolves.toBeUndefined();
      const fresh = await make().get("selected");
      expect.soft(fresh?.messages.map(message => message.text)).toEqual(operation === "append" ? expected : messages.map(message => message.text));
      expect.soft(fresh?.messages).toEqual(operation === "append" ? durable?.messages : messages);
      expect(fresh?.title).toBe("after publication");
    } finally {
      releaseResponse.release();
      await Promise.allSettled(readers);
      persistence.request = request;
      persistence.unloaded.delete = remove;
    }
  });

it.each(cases)("%s refreshes an unloaded selection and rejects a stale hydrated append including retry", async (_name, Constructor) => {
  const { make, directory } = await fixture(Constructor);
  const first = make(), stale = make();
  await stale.listMetadata();
  await append(first, "selected", directory, [{ role: "assistant", text: "fresh", timestamp: 3 }]);
  // Hydration pairs the latest metadata and history, not the old catalog revision.
  expect((await stale.get("selected"))?.messages.at(-1)?.text).toBe("fresh");
  await append(first, "selected", directory, [{ role: "assistant", text: "accepted", timestamp: 4 }]);
  await expect(append(stale, "selected", directory, [{ role: "assistant", text: "stale", timestamp: 5 }])).rejects.toThrow("another writer");
  await expect(append(stale, "selected", directory, [{ role: "assistant", text: "retry", timestamp: 6 }])).rejects.toThrow("reload");
  expect((await make().get("selected"))?.messages.map(message => message.text)).toEqual(["title seed", "exact reply", "fresh", "accepted"]);
});
it.each(["missing message", "invalid message", "invalid usage", "future record"])("fails closed for requested %s while metadata remains available", async damage => {
  const { make, directory, databasePath } = await fixture(CodexSessionStore);
  const db = new DatabaseSync(databasePath);
  try {
    if (damage === "missing message") db.exec("DELETE FROM messages WHERE thread_id='unseen' AND ordinal=1");
    if (damage === "invalid message") db.exec("UPDATE messages SET payload='{}' WHERE thread_id='unseen' AND ordinal=1");
    if (damage === "invalid usage") db.exec("UPDATE usage_turns SET payload='{}' WHERE thread_id='unseen' AND ordinal=0");
    const store = make();
    expect(await store.listMetadata()).toHaveLength(2);
    if (damage === "future record") db.exec("UPDATE sessions SET record_version=99 WHERE thread_id='unseen'");
    await expect(store.get("unseen")).rejects.toThrow();
    await expect(store.setTitle("unseen", directory, "unsafe", "renamed")).rejects.toThrow();
    expect((await store.get("selected"))?.messages).toEqual(messages);
    expect(db.prepare("SELECT metadata FROM sessions WHERE thread_id='unseen'").get()?.metadata).not.toContain("unsafe");
  } finally { db.close(); }
});
it("backfills older SQLite catalogs once, without rewriting their history or trusting summaries from older writers", async () => {
  const { make, databasePath } = await fixture(CodexSessionStore);
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("DROP TABLE session_summaries");
    db.exec("CREATE TABLE writes(entity TEXT)");
    for (const table of ["messages", "usage_turns"]) for (const op of ["INSERT", "UPDATE", "DELETE"]) db.exec(`CREATE TRIGGER audit_${table}_${op} AFTER ${op} ON ${table} BEGIN INSERT INTO writes VALUES ('${table}'); END`);
    expect(await make().listMetadata()).toHaveLength(2);
    expect(db.prepare("SELECT * FROM writes").all()).toEqual([]);
    // Simulate a base-version writer, which knows nothing about summaries.
    db.prepare("UPDATE messages SET payload=? WHERE thread_id='selected' AND ordinal=0").run(JSON.stringify({ role: "user", text: "new seed", timestamp: 1 }));
    db.exec("UPDATE sessions SET revision='older-writer-commit' WHERE thread_id='selected'");
    expect((await make().listMetadata()).find(record => record.tauThreadId === "selected")?.messages[0]?.text).toBe("new seed");
    poison(db, "messages");
    poison(db, "usage_turns");
    expect(await make().listMetadata()).toHaveLength(2);
  } finally { db.close(); }
});

it.each(cases.filter(([, Constructor]) => Constructor !== OpenCodeSessionStore))("%s usage reports read dated turns without reading any messages", async (_name, Constructor) => {
  const { make, databasePath } = await fixture(Constructor);
  const db = new DatabaseSync(databasePath);
  try {
    poison(db, "messages");
    const store = make();
    if (!("listUsage" in store)) throw new Error("Expected usage store");
    const report = await store.listUsage();
    expect(report.map(record => record.usageTurns)).toEqual([turns, turns]);
    expect(await store.listMetadata()).toHaveLength(2);
    await expect(store.get("selected")).rejects.toThrow();
  } finally { db.close(); }
});

it.each(cases)("%s publishes the first user seed when it arrives after an empty thread", async (_name, Constructor) => {
  const { make, directory } = await fixture(Constructor);
  const store = make();
  await store.ensure("new", directory);
  await append(store, "new", directory, messages);
  const metadata = (await make().listMetadata()).find(record => record.tauThreadId === "new");
  expect(metadata?.messageCount).toBe(2);
  expect(metadata?.messages[0]?.text).toBe("title seed");
});

it.each(cases)("%s refuses a concurrent restore over a thread recreated by another writer", async (_name, Constructor) => {
  const { make, directory } = await fixture(Constructor);
  const owner = make();
  const taken = await owner.take("unseen");
  const stale = make();
  await stale.listMetadata();
  await owner.put("unseen", taken);
  await append(owner, "unseen", directory, [{ role: "assistant", text: "after restore", timestamp: 3 }]);
  await expect(stale.put("unseen", taken)).rejects.toThrow("another writer");
  expect((await make().get("unseen"))?.messages.at(-1)?.text).toBe("after restore");
});

it.each(cases.filter(([, Constructor]) => Constructor !== AntigravitySessionStore && Constructor !== ClaudeRuntimeSessionStore))("%s full listing of one instance never hydrates another instance", async (_name, Constructor) => {
  const { make, databasePath } = await fixture(Constructor, "work");
  const db = new DatabaseSync(databasePath);
  try {
    poison(db, "messages", "selected");
    poison(db, "usage_turns", "selected");
    const records = await make().list("work");
    expect(records).toHaveLength(1);
    expect(records[0]?.messages).toEqual(messages);
  } finally { db.close(); }
});

it("reports usage after an older writer invalidates a warm summary without reading messages", async () => {
  const { make, databasePath } = await fixture(CodexSessionStore);
  const store = make();
  await store.listMetadata();
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("UPDATE sessions SET revision='older-writer' WHERE thread_id='selected'");
    poison(db, "messages");
    if (!("listUsage" in store)) throw new Error("Expected usage store");
    expect((await store.listUsage()).map(record => record.usageTurns)).toEqual([turns, turns]);
  } finally { db.close(); }
});

it.each(cases)("%s recreates or restores observed bulk deletions and still rejects concurrent creation", async (_name, Constructor) => {
  const { make, directory } = await fixture(Constructor);
  const observer = make(), owner = make();
  await observer.listMetadata();
  const selected = await owner.take("selected");
  const unseen = await owner.take("unseen");
  expect(await observer.list()).toEqual([]);
  await observer.ensure("selected", directory);
  await observer.put("unseen", unseen);
  expect((await make().get("selected"))?.messages).toEqual([]);
  expect(await make().get("unseen")).toEqual(unseen);
  const racing = make();
  await racing.listMetadata();
  await observer.take("selected");
  await racing.list();
  await observer.put("selected", selected);
  await expect(racing.ensure("selected", directory)).rejects.toThrow("another writer");
});

it("invalidates pre-decoder Claude summaries and commits exact SQLite deltas with their accounting marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-claude-summary-"));
  directories.push(directory);
  const filePath = join(directory, "sessions.json");
  const cumulative = [
    { ...usage, provider: "anthropic", model: "opus", inputTokens: 100, totalTokens: 102, costUsd: 10, at: 2 },
    { ...usage, provider: "anthropic", model: "opus", inputTokens: 150, totalTokens: 152, costUsd: 15, at: 3 },
  ];
  const oldRecord = { tauThreadId: "thread", claudeSessionId: "123e4567-e89b-12d3-a456-426614174000", cwd: directory,
    lastAttemptAt: 1, started: true, updatedAt: 3, messages: [...messages, { role: "user", text: "latest user", timestamp: 3 }],
    usageTurns: cumulative, usage: { ...usage, inputTokens: 250, totalTokens: 254, costUsd: 25, turns: 2 } };
  // The previous child decoder wrote cumulative rows and a revision-valid summary.
  const old = new SessionStorePersistence<typeof oldRecord>({ filePath, version: 1, immutableUsageTurns: true,
    decode: value => value as { sessions: typeof oldRecord[] }, summarizeUsage: record => mergeTallies(record.usageTurns) });
  try { await old.write({ sessions: [{ id: "thread", record: oldRecord }] }); }
  finally { await old.dispose(); }
  const make = () => { const store = new ClaudeRuntimeSessionStore({ filePath }); stores.push(store); return store; };
  const db = new DatabaseSync(`${filePath}.sqlite`);
  const raw = () => JSON.parse(String(db.prepare("SELECT metadata FROM sessions WHERE thread_id='thread'").get()?.metadata)).sessions[0];
  const persistedTurns = () => db.prepare("SELECT payload FROM usage_turns WHERE thread_id='thread' ORDER BY ordinal").all().map(row => JSON.parse(String(row.payload)));
  try {
    const revision = db.prepare("SELECT revision FROM sessions WHERE thread_id='thread'").get()?.revision;
    const store = make();
    expect((await store.listMetadata())[0]?.messageCount).toBe(3);
    const recovered = recoverUsageTurns(cumulative);
    expect(store.talliesOf("thread")).toEqual(mergeTallies(recovered.turns));
    expect(raw().usageAccounting).toBeUndefined();
    expect(persistedTurns()).toEqual(cumulative);
    expect(db.prepare("SELECT revision FROM sessions WHERE thread_id='thread'").get()?.revision).toBe(revision);
    const selected = await store.get("thread");
    expect(selected?.messages).toEqual(oldRecord.messages);
    expect(selected?.usageTurns).toEqual(recovered.turns);
    expect(selected?.usageSnapshot).toEqual(recovered.snapshot);
    expect(selected?.usageAccounting).toBe("delta");
    expect(raw().usageAccounting).toBeUndefined();
    db.exec("CREATE TRIGGER fail_usage BEFORE INSERT ON usage_turns BEGIN SELECT RAISE(ABORT, 'fixture usage failure'); END");
    await expect(store.setTitle("thread", directory, "failed", "renamed")).rejects.toThrow("fixture usage failure");
    expect(raw().usageAccounting).toBeUndefined();
    expect(persistedTurns()).toEqual(cumulative);
    await store.dispose();
    db.exec("DROP TRIGGER fail_usage");
    const writer = make();
    await writer.setTitle("thread", directory, "renamed", "renamed");
    expect(persistedTurns()).toEqual(recovered.turns);
    expect(raw()).toMatchObject({ usageAccounting: "delta", usageSnapshot: recovered.snapshot });
    await writer.dispose();
    // A valid upgraded summary now needs no payload reads, even with poisoned rows.
    poison(db, "messages");
    poison(db, "usage_turns");
    const metadataOnly = make();
    expect(await metadataOnly.listMetadata()).toHaveLength(1);
    expect(metadataOnly.talliesOf("thread")).toEqual(mergeTallies(recovered.turns));
    await metadataOnly.dispose();
    for (const table of ["messages", "usage_turns"]) db.exec(`DROP VIEW ${table}; ALTER TABLE fixture_${table} RENAME TO ${table}`);
    const resumed = make();
    const record = (await resumed.get("thread"))!;
    expect(record.usageTurns).toEqual(recovered.turns);
    const accounting = new ClaudeUsage(record.usageSnapshot);
    accounting.beginProcess("2.1.277", true);
    expect(accounting.take([cumulative[1]!])[0]?.costUsd).toBe(0);
    const next = { ...cumulative[1]!, inputTokens: 160, totalTokens: 162, costUsd: 16, at: 4 };
    const delta = { ...accounting.take([next])[0]!, at: 4 };
    expect(delta.costUsd).toBe(1);
    const snapshot = accounting.snapshot();
    await resumed.recordUsage("thread", directory, { ...record.usage!, inputTokens: 160, totalTokens: 162, costUsd: 16, turns: 3 }, [delta], snapshot);
    snapshot[0]!.costUsd = 999;
    expect((await make().get("thread"))?.usageSnapshot?.[0]?.costUsd).toBe(16);
    expect((await resumed.get("thread"))?.usageTurns?.map(turn => turn.costUsd)).toEqual([10, 5, 1]);
  } finally { db.close(); }
});

it.each(cases)("%s reports an unavailable published database and retries after repair", async (_name, Constructor) => {
  const { make, databasePath } = await fixture(Constructor);
  const { readFile } = await import("node:fs/promises");
  const original = await readFile(databasePath);
  await writeFile(databasePath, "corrupt published SQLite database");
  const store = make();
  await expect(store.listMetadata()).rejects.toThrow();
  await expect(store.listMetadata()).rejects.toThrow();
  await writeFile(databasePath, original);
  expect((await store.listMetadata()).map(record => record.tauThreadId)).toEqual(["selected", "unseen"]);
  expect((await store.get("selected"))?.messages).toEqual(messages);
});

it.each(cases)("%s selects search changes before reading payloads and does not hydrate its cache", async (_name, Constructor) => {
  const { make, databasePath } = await fixture(Constructor);
  const db = new DatabaseSync(databasePath);
  try {
    poison(db, "messages", "selected");
    poison(db, "usage_turns");
    const store = make();
    // The known thread's broken payload must never be read. Search is text-only.
    expect(await store.threadTexts({ limit: 1 })).toMatchObject({ threads: [{ threadId: "selected" }], more: true });
    expect(await store.threadTexts({ known: { unseen: 2, gone: 1 }, limit: 1 })).toEqual({
      threads: [{ threadId: "selected", updatedAt: 2, messages: messages.map(({ role, text }) => ({ role, text })) }],
      removed: ["gone"], more: false,
    });
    const persistence = (store as unknown as { persistence: { isUnloaded(id: string): boolean } }).persistence;
    expect(persistence.isUnloaded("selected")).toBe(true);
    expect(persistence.isUnloaded("unseen")).toBe(true);
    expect(await store.threadTexts({ known: { selected: 2, unseen: 2 } })).toEqual({ threads: [], removed: [], more: false });
  } finally { db.close(); }
});

it.each(cases)("%s bounds histories after browsing and releases cached payloads without losing later appends", async (_name, Constructor) => {
  const directory = await mkdtemp(join(tmpdir(), "tau-history-cache-"));
  directories.push(directory);
  const filePath = join(directory, "sessions.json");
  const ids = Array.from({ length: 12 }, (_, index) => `thread-${index}`);
  const transcript = [...messages, { role: "assistant", text: "x".repeat(1_024), timestamp: 3 }];
  await writeFile(filePath, JSON.stringify({ version: 1, sessions: ids.map(tauThreadId => ({ tauThreadId, cwd: directory, updatedAt: 3, messages: transcript,
    ...(Constructor === ClaudeRuntimeSessionStore ? { claudeSessionId: "123e4567-e89b-12d3-a456-426614174000" } : {}), usage, usageTurns: turns })) }));
  const store = new Constructor({ filePath });
  stores.push(store);
  for (const id of ids) expect((await store.get(id))?.messages).toEqual(transcript);
  await new Promise<void>(resolve => setImmediate(resolve));
  const cache = (store as unknown as { records: Map<string, { messages: unknown[] }>; persistence: { histories: Map<string, unknown>; snapshots: Map<string, { messages?: unknown[]; usage: unknown[] }> } });
  expect([...cache.records.values()].filter(record => record.messages.length > 1).length).toBeLessThanOrEqual(8);
  expect(cache.persistence.histories.size).toBeLessThanOrEqual(8);
  await store.flushAndRelease();
  expect([...cache.records.values()].every(record => record.messages.length === 1)).toBe(true);
  expect([...cache.persistence.snapshots.values()].every(snapshot => snapshot.messages === undefined && snapshot.usage.length === 0)).toBe(true);
  await Promise.all([append(store, ids[0]!, directory, [{ role: "assistant", text: "accepted", timestamp: 4 }]),
    append(store, ids[0]!, directory, [{ role: "assistant", text: "concurrent", timestamp: 5 }])]);
  await store.flushAndRelease();
  const reopened = new Constructor({ filePath });
  stores.push(reopened);
  expect((await reopened.get(ids[0]!))?.messages.map(message => message.text)).toEqual([...transcript.map(message => message.text), "accepted", "concurrent"]);
  expect((await reopened.listMetadata()).map(record => record.messageCount)).toContain(5);
});

it.each(cases)("%s streams search text up to its UTF-16 budget without reading later rows", async (_name, Constructor) => {
  const { make, databasePath } = await fixture(Constructor);
  const db = new DatabaseSync(databasePath);
  const long = "😀".repeat(200_000);
  try {
    const payload = { role: "assistant", timestamp: 2, ...(Constructor === ClaudeRuntimeSessionStore
      ? { textChunks: [long.slice(0, 100_000), long.slice(100_000)] } : { text: long }) };
    db.prepare("UPDATE messages SET payload=? WHERE thread_id='selected' AND ordinal=1").run(JSON.stringify(payload));
    db.prepare("INSERT INTO messages VALUES ('selected',2,?)").run("invalid JSON after the budget");
    db.exec("UPDATE sessions SET message_count=3 WHERE thread_id='selected'");
    const store = make();
    const answer = await store.threadTexts({ known: { unseen: 2 } });
    expect(answer.threads[0]?.messages).toEqual([{ role: "user", text: messages[0]!.text },
      { role: "assistant", text: long.slice(0, THREAD_TEXT_CHARS - messages[0]!.text.length) }]);
    expect(answer.threads[0]!.messages.reduce((size, message) => size + message.text.length, 0)).toBe(THREAD_TEXT_CHARS);
    expect((await store.listMetadata()).find(record => record.tauThreadId === "selected")?.messageCount).toBe(3);
  } finally { db.close(); }
});

it.each(cases)("%s keeps search available for a future JSON store without changing its source", async (_name, Constructor) => {
  const directory = await mkdtemp(join(tmpdir(), "tau-future-search-"));
  directories.push(directory);
  const filePath = join(directory, "sessions.json");
  const original = JSON.stringify({ version: 99, sessions: [{ tauThreadId: "future", cwd: directory, updatedAt: 2, messages,
    ...(Constructor === ClaudeRuntimeSessionStore ? { claudeSessionId: "123e4567-e89b-12d3-a456-426614174000" } : {}) }] });
  await writeFile(filePath, original);
  const store = new Constructor({ filePath });
  stores.push(store);
  expect(await store.threadTexts({})).toEqual({ threads: [{ threadId: "future", updatedAt: 2,
    messages: messages.map(({ role, text }) => ({ role, text })) }], removed: [], more: false });
  const { readFile } = await import("node:fs/promises");
  expect(await readFile(filePath, "utf8")).toBe(original);
});

it("pins cached histories while a bulk listing hydrates its remaining threads", async () => {
  const { make } = await fixture(CodexSessionStore, undefined, 10);
  const store = make();
  await store.listMetadata();
  const persistence = (store as unknown as { persistence: {
    scheduleEviction(): void; evictHistories(): void;
    request(operation: string, values?: Record<string, unknown>): Promise<unknown>;
  } }).persistence;
  const request = persistence.request.bind(persistence), schedule = persistence.scheduleEviction.bind(persistence);
  const responseReady = gate(), releaseResponse = gate();
  // Control eviction timing only; histories, revisions, SQLite reads and adapter publication stay real.
  persistence.scheduleEviction = () => undefined;
  for (const id of ["selected", "unseen", ...Array.from({ length: 7 }, (_, index) => `filler-${index}`)]) await store.get(id);
  persistence.request = async (operation, values) => {
    const value = await request(operation, values);
    if (operation === "histories") { responseReady.release(); await releaseResponse.promise; }
    return value;
  };
  const listing = store.list();
  try {
    await responseReady.promise;
    persistence.evictHistories();
    releaseResponse.release();
    const records = await listing;
    expect(records).toHaveLength(12);
    expect(records.every(record => JSON.stringify(record.messages) === JSON.stringify(messages))).toBe(true);
  } finally {
    releaseResponse.release();
    await listing;
    persistence.request = request; persistence.scheduleEviction = schedule;
  }
});

it("pins a large accepted append until commit and then evicts it while preserving metadata and usage summaries", async () => {
  const { make, directory } = await fixture(CodexSessionStore);
  const store = make() as CodexSessionStore;
  await store.setTitle("selected", directory, "kept title", "renamed");
  const persistence = (store as unknown as { persistence: {
    request(operation: string, values?: Record<string, unknown>): Promise<unknown>;
    evictHistories(): void; isUnloaded(id: string): boolean;
  } }).persistence;
  const request = persistence.request.bind(persistence);
  const responseReady = gate(), releaseResponse = gate();
  persistence.request = async (operation, values) => {
    const value = await request(operation, values);
    if (operation === "write") { responseReady.release(); await releaseResponse.promise; }
    return value;
  };
  const long = "x".repeat(5_000_000);
  const accepted = store.appendMessages("selected", directory, [{ id: "large", role: "assistant", text: long, timestamp: 3 }]);
  try {
    await responseReady.promise;
    persistence.evictHistories();
    expect(persistence.isUnloaded("selected")).toBe(false);
    releaseResponse.release();
    await accepted;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(persistence.isUnloaded("selected")).toBe(true);
    const metadata = (await store.listMetadata()).find(record => record.tauThreadId === "selected");
    expect(metadata).toMatchObject({ title: "kept title", messageCount: 3, usage });
    expect(metadata?.messages).toEqual([messages[0]]);
    expect(store.talliesOf("selected")).toEqual(mergeTallies(turns));
    expect((await make().get("selected"))?.messages.at(-1)?.text).toBe(long);
    expect((await store.threadTexts({ known: { unseen: 2 } })).threads[0]!.messages.reduce((size, message) => size + message.text.length, 0)).toBe(THREAD_TEXT_CHARS);
  } finally {
    releaseResponse.release(); await accepted;
    persistence.request = request;
  }
});
