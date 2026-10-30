import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, rename, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { SessionStorePersistence } from "./session-store-persistence.js";

type Record = { tauThreadId: string; updatedAt?: number; title?: string; messages?: unknown[]; usageTurns?: unknown[] };
const directories: string[] = [];
const stores: SessionStorePersistence<Record, string>[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.dispose()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tau-sqlite-sessions-"));
  directories.push(directory);
  return { directory, filePath: join(directory, "sessions.json") };
}
function makeStore(filePath: string) {
  const store = new SessionStorePersistence<Record, string>({ filePath, version: 1, immutableUsageTurns: true,
    decode: (value) => value as { sessions: Record[]; models?: { [id: string]: string[] } } });
  stores.push(store);
  return store;
}
function query<T>(filePath: string, action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(`${filePath}.sqlite`);
  try { return action(db); } finally { db.close(); }
}

it.each(["cjs", "esm"] as const)("runs the embedded SQLite worker from a real %s bundle and preserves concurrent writers", async (format) => {
  const { directory, filePath } = await fixture();
  const bundle = join(directory, `persistence.${format === "cjs" ? "cjs" : "mjs"}`);
  await build({ entryPoints: [fileURLToPath(new URL("./session-store-persistence.ts", import.meta.url))], outfile: bundle,
    bundle: true, platform: "node", target: "node20", format,
    alias: { "tau/host-extension": resolve("src/main/host-extension-api.ts") } });
  const children: ReturnType<typeof start>[] = [];
  function start(prefix: string) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { pathToFileURL } from 'node:url';
      const { SessionStorePersistence } = await import(pathToFileURL(process.argv[1]));
      const store = new SessionStorePersistence({filePath:process.argv[2],version:1,decode:v=>v});
      await store.load();
      process.once('message', async()=>{
        try {
          for(let i=0;i<10;i++) await store.write({sessions:[{id:process.argv[3]+i,record:{tauThreadId:process.argv[3]+i,updatedAt:i,messages:[{role:'user',text:'bundled paging'}]}}]});
          const catalog = await store.threadTexts([], {protocol:2});
          const entry = catalog.catalog.find(row=>row.threadId===process.argv[3]+'9');
          const answer = await store.threadTexts([], {protocol:2,page:{threadId:entry.threadId,version:entry.version}});
          if(answer.page.status!=='ok'||answer.page.chunks[0]?.text!=='bundled paging'||answer.page.nextCursor!==null) throw new Error('Incomplete bundled text page');
        }
        catch(error){console.error(error);process.exitCode=1;}
        finally { await store.dispose(); process.disconnect(); }
      });
      process.send('ready');
    `, bundle, filePath, prefix], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let errors = "";
    child.stderr!.on("data", (data) => { errors += String(data); });
    const exited = new Promise<number | null>((done) => child.once("exit", done));
    const ready = new Promise<void>((done, fail) => { child.once("message", () => done()); child.once("error", fail); child.once("exit", () => fail(new Error(errors))); });
    return { child, exited, ready, errors: () => errors };
  }
  try {
    children.push(start("first-"), start("second-"));
    await Promise.all(children.map((child) => child.ready));
    for (const child of children) child.child.send("write");
    expect(await Promise.all(children.map((child) => child.exited)), children.map((child) => child.errors()).join("\n")).toEqual([0, 0]);
    expect((await makeStore(filePath).load())?.sessions.map((record) => record.tauThreadId).sort()).toEqual(
      ["first-", "second-"].flatMap((prefix) => Array.from({ length: 10 }, (_, i) => `${prefix}${i}`)));
  } finally {
    for (const child of children) if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill();
    await Promise.all(children.map((child) => child.exited));
  }
});

it("migrates legacy data atomically, retains the source and makes database files private", async () => {
  const { filePath } = await fixture();
  const legacy = JSON.stringify({ version: 1, sessions: [{ tauThreadId: "../thread", title: "kept", messages: ["first"] }], models: { work: ["model"] } });
  await writeFile(filePath, legacy);
  const store = makeStore(filePath);
  expect(await store.load()).toEqual({ sessions: [{ tauThreadId: "../thread", title: "kept", messages: ["first"] }], models: { work: ["model"] } });
  expect(await readFile(`${filePath}.pre-sqlite`, "utf8")).toBe(legacy);
  expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ version: 4, layout: "sqlite-sessions" });
  // Initial hydration releases its bulk reader; the first mutation reopens the
  // retained writer and creates its owner-only WAL sidecars.
  const record = (await store.load())!.sessions[0]!;
  await store.write({ sessions: [{ id: record.tauThreadId, record, appendOnly: true }] });
  for (const path of [store.databasePath, `${store.databasePath}-wal`, `${store.databasePath}-shm`]) expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(query(filePath, (db) => db.prepare("SELECT value FROM store_meta WHERE key='import_digest'").get()?.value)).toBeTypeOf("string");
  expect(await makeStore(filePath).load()).toEqual(await store.load());
});

it.each([2, 3])("migrates v%i per-thread records, hiding unpublished chunk tails", async (version) => {
  const { filePath } = await fixture();
  const directory = `${filePath}.records`;
  await mkdir(directory);
  const hash = createHash("sha256").update("old").digest("hex");
  const epoch = "123e4567-e89b-12d3-a456-426614174000";
  await writeFile(filePath, JSON.stringify({ version, layout: version === 2 ? "thread-records" : "thread-records-messages" }));
  await writeFile(join(directory, `session-${hash}.json`), JSON.stringify({ version: 1, sessions: [{ tauThreadId: "old", messages: version === 2 ? ["kept"] : [] }],
    ...(version === 3 ? { messagePointer: { epoch, count: 1, parts: 1, tailCount: 1, tailBytes: 10 } } : {}) }));
  if (version === 3) await writeFile(join(directory, `message-${hash}-${epoch}-0.json`), JSON.stringify({ version: 1, messages: ["kept", "unpublished"] }));
  const store = makeStore(filePath);
  const record = (await store.load())!.sessions[0]!;
  expect(record.messages).toEqual(["kept"]);
  record.messages!.push("appended");
  await store.write({ sessions: [{ id: "old", record, appendOnly: true }] });
  expect((await makeStore(filePath).load())?.sessions[0]?.messages).toEqual(["kept", "appended"]);
  expect(JSON.parse(await readFile(filePath, "utf8")).version).toBe(4);
});

it("reuses a committed migration receipt after interrupted marker publication without erasing updates", async () => {
  const { filePath } = await fixture();
  const legacy = JSON.stringify({ version: 1, sessions: [{ tauThreadId: "actual", messages: ["old"] }] });
  await writeFile(filePath, legacy);
  const store = makeStore(filePath);
  await store.load();
  await store.write({ sessions: [{ id: "actual", record: { tauThreadId: "actual", messages: ["old", "updated"] } }] });
  await writeFile(filePath, legacy);
  expect((await makeStore(filePath).load())?.sessions[0]?.messages).toEqual(["old", "updated"]);
});

it("refuses changed legacy data after migration rather than overwriting the database", async () => {
  const { filePath } = await fixture();
  await makeStore(filePath).write({ sessions: [{ id: "actual", record: { tauThreadId: "actual" } }] });
  await writeFile(filePath, JSON.stringify({ version: 1, sessions: [{ tauThreadId: "different" }] }));
  await expect(makeStore(filePath).load()).rejects.toThrow("changed after SQLite migration");
  expect(query(filePath, (db) => db.prepare("SELECT thread_id FROM sessions").all())).toEqual([{ thread_id: "actual" }]);
});

it("refuses newer schemas and leaves the source intact", async () => {
  const { filePath } = await fixture();
  const original = JSON.stringify({ version: 99, sessions: [{ tauThreadId: "future" }] });
  await writeFile(filePath, original);
  const store = makeStore(filePath);
  expect((await store.load())?.sessions).toEqual([{ tauThreadId: "future" }]);
  await expect(store.write({ sessions: [{ id: "future" }] })).rejects.toThrow("Unsupported");
  expect(await readFile(filePath, "utf8")).toBe(original);
});

it("does not resurrect deletions or overwrite untouched threads/catalogs in stale stores", async () => {
  const { filePath } = await fixture();
  const first = makeStore(filePath);
  await first.write({ sessions: [{ id: "deleted", record: { tauThreadId: "deleted" } }] });
  const stale = makeStore(filePath); await stale.load();
  await first.write({ sessions: [{ id: "deleted" }], models: [{ id: "first", models: ["a"] }] });
  const record = { tauThreadId: "other", title: "frozen" };
  const queued = stale.write({ sessions: [{ id: "other", record }], models: [{ id: "second", models: ["b"] }] });
  record.title = "mutated"; await queued;
  expect(await makeStore(filePath).load()).toEqual({ sessions: [{ tauThreadId: "other", title: "frozen" }], models: { first: ["a"], second: ["b"] } });
});

it("writes no history rows or old text on metadata changes and exactly one message on append", async () => {
  const { filePath } = await fixture();
  let serializations = 0;
  const old = { role: "user", text: "x".repeat(1024 * 1024), toJSON() { serializations++; return { text: this.text }; } };
  const store = makeStore(filePath);
  const record = { tauThreadId: "long", messages: [old] as unknown[], usageTurns: [{ tokens: 1 }] as unknown[], title: "before" };
  await store.write({ sessions: [{ id: "long", record, appendOnly: true }] });
  query(filePath, (db) => {
    db.exec("CREATE TABLE writes(table_name TEXT)");
    for (const table of ["sessions", "messages", "usage_turns"]) for (const op of ["INSERT", "UPDATE", "DELETE"]) {
      db.exec(`CREATE TRIGGER count_${table}_${op} AFTER ${op} ON ${table} BEGIN INSERT INTO writes VALUES ('${table}'); END`);
    }
  });
  serializations = 0;
  record.title = "after";
  await store.write({ sessions: [{ id: "long", record, appendOnly: true }] });
  expect(query(filePath, (db) => db.prepare("SELECT * FROM writes").all())).toEqual([{ table_name: "sessions" }]);
  query(filePath, (db) => db.exec("DELETE FROM writes"));
  record.messages.push({ text: "new" });
  await store.write({ sessions: [{ id: "long", record, appendOnly: true }] });
  expect(query(filePath, (db) => db.prepare("SELECT * FROM writes ORDER BY table_name").all())).toEqual([{ table_name: "messages" }, { table_name: "sessions" }]);
  expect(serializations).toBe(0);
});

it("updates only folded usage boundaries and the appended turn, preserving the suffix", async () => {
  const { filePath } = await fixture();
  const store = makeStore(filePath);
  const first = { tokens: 1 }, second = { tokens: 2 }, third = { tokens: 3 };
  const record = { tauThreadId: "usage", usageTurns: [first, second, third] };
  await store.write({ sessions: [{ id: "usage", record, appendOnly: true }] });
  record.usageTurns = [{ tokens: 3 }, third, { tokens: 4 }];
  await store.write({ sessions: [{ id: "usage", record, appendOnly: true }] });
  expect(query(filePath, (db) => db.prepare("SELECT ordinal,payload FROM usage_turns ORDER BY ordinal").all())).toEqual([
    { ordinal: 1, payload: '{"tokens":3}' }, { ordinal: 2, payload: '{"tokens":3}' }, { ordinal: 3, payload: '{"tokens":4}' },
  ]);
  expect((await makeStore(filePath).load())?.sessions[0]?.usageTurns).toEqual(record.usageTurns);
});

it("rolls back all changed records when any row fails, rejects dependent appends, and permits a complete retry", async () => {
  const { filePath } = await fixture();
  const store = makeStore(filePath); await store.load();
  const record = { tauThreadId: "wrong", messages: ["first"] };
  const first = store.write({ sessions: [{ id: "independent", record: { tauThreadId: "independent" } }, { id: "correct", record, appendOnly: true }] });
  record.tauThreadId = "correct"; record.messages.push("second");
  const second = store.write({ sessions: [{ id: "correct", record, appendOnly: true }] });
  expect((await Promise.allSettled([first, second])).map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
  expect((await makeStore(filePath).load())?.sessions).toEqual([]);
  await store.write({ sessions: [{ id: "correct", record, appendOnly: true }] });
  expect((await makeStore(filePath).load())?.sessions[0]?.messages).toEqual(["first", "second"]);
});

it("freezes queued append batches without replacing their snapshot during initial load", async () => {
  const { filePath } = await fixture();
  const store = makeStore(filePath);
  const record = { tauThreadId: "queued", messages: ["first"], title: "first" };
  const first = store.write({ sessions: [{ id: "queued", record, appendOnly: true }] });
  record.messages.push("second"); record.title = "second";
  const second = store.write({ sessions: [{ id: "queued", record, appendOnly: true }] });
  record.messages.push("unpersisted");
  await Promise.all([first, second]);
  expect((await makeStore(filePath).load())?.sessions).toEqual([{ tauThreadId: "queued", messages: ["first", "second"], title: "second" }]);
});

it("rejects stale same-thread append revisions rather than losing the other writer's turn", async () => {
  const { filePath } = await fixture();
  const first = makeStore(filePath);
  const record = { tauThreadId: "shared", messages: ["first"] };
  await first.write({ sessions: [{ id: "shared", record, appendOnly: true }] });
  const stale = makeStore(filePath), old = (await stale.load())!.sessions[0]!;
  record.messages.push("accepted"); await first.write({ sessions: [{ id: "shared", record, appendOnly: true }] });
  old.messages!.push("stale");
  await expect(stale.write({ sessions: [{ id: "shared", record: old, appendOnly: true }] })).rejects.toThrow("another writer");
  expect((await makeStore(filePath).load())?.sessions[0]?.messages).toEqual(["first", "accepted"]);
  // The losing host reads the thread back instead of refusing it until a restart.
  await new Promise((done) => setImmediate(done));
  expect(stale.isUnloaded("shared")).toBe(true);
  const reread = (await stale.loadSession("shared"))!;
  expect(reread.messages).toEqual(["first", "accepted"]);
  reread.messages!.push("after");
  await stale.write({ sessions: [{ id: "shared", record: reread, appendOnly: true }] });
  expect((await makeStore(filePath).load())?.sessions[0]?.messages).toEqual(["first", "accepted", "after"]);
});

it("holds a failed write against its own thread only and writes the whole record once the database takes it", async () => {
  const { filePath } = await fixture();
  const seed = makeStore(filePath);
  await seed.write({ sessions: [{ id: "cold", record: { tauThreadId: "cold", messages: ["kept"] } }] });
  await seed.dispose();
  const store = makeStore(filePath); await store.loadMetadata();
  const failing = { tauThreadId: "failing", messages: ["one"] }, other = { tauThreadId: "other", messages: ["a"] };
  await store.write({ sessions: [{ id: "failing", record: failing, appendOnly: true }, { id: "other", record: other, appendOnly: true }] });
  query(filePath, (db) => db.exec("UPDATE sessions SET record_version=99 WHERE thread_id='failing'"));
  failing.messages.push("two");
  await expect(store.write({ sessions: [{ id: "failing", record: failing, appendOnly: true }] })).rejects.toThrow("version 99");
  other.messages.push("b");
  await store.write({ sessions: [{ id: "other", record: other, appendOnly: true }] });
  expect(store.isUnloaded("cold")).toBe(true);
  await expect(store.loadSession("cold")).resolves.toMatchObject({ messages: ["kept"] });
  query(filePath, (db) => db.exec("UPDATE sessions SET record_version=1 WHERE thread_id='failing'"));
  failing.messages.push("three");
  await store.write({ sessions: [{ id: "failing", record: failing, appendOnly: true }] });
  failing.messages.push("four");
  await store.write({ sessions: [{ id: "failing", record: failing, appendOnly: true }] });
  const saved = new Map((await makeStore(filePath).load())!.sessions.map((record) => [record.tauThreadId, record.messages]));
  expect(saved.get("failing")).toEqual(["one", "two", "three", "four"]);
  expect(saved.get("other")).toEqual(["a", "b"]);
});

it.each(["missing", "corrupt"])("never imports stale backups when a published database is %s", async (damage) => {
  const { filePath } = await fixture();
  await writeFile(filePath, JSON.stringify({ version: 1, sessions: [{ tauThreadId: "old" }] }));
  const store = makeStore(filePath); await store.load(); await store.dispose();
  if (damage === "missing") await rm(store.databasePath); else await writeFile(store.databasePath, "not a database");
  await expect(makeStore(filePath).load()).rejects.toThrow();
  expect(JSON.parse(await readFile(filePath, "utf8")).layout).toBe("sqlite-sessions");
});

it("reports a database file that is not a database as a sentence with a next step", async () => {
  const { filePath } = await fixture();
  await writeFile(filePath, JSON.stringify({ version: 1, sessions: [{ tauThreadId: "old" }] }));
  const store = makeStore(filePath); await store.load(); await store.dispose();
  await writeFile(store.databasePath, "not a database, not a database, not a database");
  const failure = await makeStore(filePath).load().catch((error: Error) => error);
  expect((failure as Error).message).toMatch(/SQLITE_NOTADB.*Keep a copy/u);
  expect(((failure as Error).cause as Error).message).toBe("file is not a database");
});

it("refuses a database removed after load, rejects future touched records and preserves independent IDs", async () => {
  const { filePath } = await fixture();
  const store = makeStore(filePath);
  await store.write({ sessions: [{ id: "future", record: { tauThreadId: "future" } }] });
  query(filePath, (db) => db.exec("UPDATE sessions SET record_version=99 WHERE thread_id='future'"));
  await expect(store.write({ sessions: [{ id: "future" }] })).rejects.toThrow("version 99");
  await store.write({ sessions: [{ id: "independent", record: { tauThreadId: "independent" } }] });
  await rm(store.databasePath);
  await expect(store.write({ sessions: [{ id: "new", record: { tauThreadId: "new" } }] })).rejects.toThrow();
});

it("drains accepted writes on dispose, rejects new writes immediately and remains idempotent", async () => {
  const { filePath } = await fixture();
  const store = makeStore(filePath);
  const accepted = store.write({ sessions: [{ id: "accepted", record: { tauThreadId: "accepted" } }] });
  const closing = store.dispose();
  await expect(store.write({ sessions: [{ id: "late", record: { tauThreadId: "late" } }] })).rejects.toThrow("disposed");
  await Promise.all([accepted, closing, store.dispose()]);
  expect((await makeStore(filePath).load())?.sessions.map((row) => row.tauThreadId)).toEqual(["accepted"]);
});

it("refuses to migrate future per-thread schemas without losing their unknown fields", async () => {
  const { filePath } = await fixture();
  await mkdir(`${filePath}.records`);
  const marker = JSON.stringify({ version: 2, layout: "thread-records" });
  await writeFile(filePath, marker);
  const hash = createHash("sha256").update("future").digest("hex");
  const recordPath = join(`${filePath}.records`, `session-${hash}.json`);
  const source = JSON.stringify({ version: 99, sessions: [{ tauThreadId: "future", unknownField: { preserved: true } }] });
  await writeFile(recordPath, source);
  await expect(makeStore(filePath).load()).rejects.toThrow("Unsupported legacy session record version");
  expect(await readFile(recordPath, "utf8")).toBe(source);
  expect(await readFile(filePath, "utf8")).toBe(marker);
});

it("flushes and releases for kit reload while allowing retained runtimes to append afterwards", async () => {
  const { filePath } = await fixture();
  const store = makeStore(filePath);
  const record = { tauThreadId: "retained", messages: ["before"] };
  const accepted = store.write({ sessions: [{ id: "retained", record, appendOnly: true }] });
  const released = store.flushAndRelease();
  record.messages.push("after");
  const appended = store.write({ sessions: [{ id: "retained", record, appendOnly: true }] });
  await Promise.all([accepted, released, appended]);
  expect((await makeStore(filePath).load())?.sessions[0]?.messages).toEqual(["before", "after"]);
  await store.flushAndRelease();
});

it("serializes worker release with a concurrent initial load", async () => {
  const { filePath } = await fixture();
  const store = makeStore(filePath);
  const released = store.flushAndRelease();
  const loaded = store.load();
  await Promise.all([released, loaded]);
  await store.write({ sessions: [{ id: "after-load", record: { tauThreadId: "after-load", messages: ["kept"] }, appendOnly: true }] });
  expect((await makeStore(filePath).load())?.sessions[0]?.messages).toEqual(["kept"]);
});

it("rejects new public loads during and after terminal disposal without creating a database", async () => {
  const { filePath } = await fixture();
  const store = makeStore(filePath);
  const closing = store.dispose();
  await expect(store.load()).rejects.toThrow("disposed");
  await closing;
  await expect(store.load()).rejects.toThrow("disposed");
  await expect(stat(store.databasePath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("detects changed published chunk text during an interrupted migration with an unchanged pointer", async () => {
  const { filePath } = await fixture();
  await mkdir(`${filePath}.records`);
  const marker = JSON.stringify({ version: 3, layout: "thread-records-messages" });
  await writeFile(filePath, marker);
  const hash = createHash("sha256").update("chunk").digest("hex");
  const epoch = "123e4567-e89b-12d3-a456-426614174000";
  await writeFile(join(`${filePath}.records`, `session-${hash}.json`), JSON.stringify({ version: 1, sessions: [{ tauThreadId: "chunk", messages: [] }],
    messagePointer: { epoch, count: 1, parts: 1, tailCount: 1, tailBytes: 10 } }));
  const chunk = join(`${filePath}.records`, `message-${hash}-${epoch}-0.json`);
  await writeFile(chunk, JSON.stringify({ version: 1, messages: ["original"] }));
  await makeStore(filePath).load();
  await writeFile(filePath, marker);
  await writeFile(chunk, JSON.stringify({ version: 1, messages: ["changed"] }));
  await expect(makeStore(filePath).load()).rejects.toThrow("changed after SQLite migration");
  expect(query(filePath, (db) => db.prepare("SELECT payload FROM messages").get()?.payload)).toBe('"original"');
});

it("refuses to persist a metadata projection as a replacement or append, preserving unseen messages and usage", async () => {
  const { filePath } = await fixture();
  const writer = makeStore(filePath);
  await writer.write({ sessions: [{ id: "unseen", record: { tauThreadId: "unseen", messages: ["first", "second"], usageTurns: [{ tokens: 2 }] } }] });
  const cold = makeStore(filePath);
  const preview = (await cold.loadMetadata())!.sessions[0]!;
  expect(preview.messages).toEqual([]);
  preview.title = "metadata only";
  for (const appendOnly of [false, true]) await expect(cold.write({ sessions: [{ id: "unseen", record: preview, appendOnly }] })).rejects.toThrow("history is not loaded");
  expect((await makeStore(filePath).load())?.sessions[0]).toEqual({ tauThreadId: "unseen", messages: ["first", "second"], usageTurns: [{ tokens: 2 }] });
  const record = (await cold.loadSession("unseen"))!;
  record.title = "hydrated";
  const accepted = cold.write({ sessions: [{ id: "unseen", record, appendOnly: true }] });
  const closing = cold.dispose();
  await expect(cold.loadSession("unseen")).rejects.toThrow("disposed");
  await Promise.all([accepted, closing]);
  expect((await makeStore(filePath).load())?.sessions[0]).toEqual({ ...record });
});

it("refuses a published database replaced between cold metadata and selected history even after the reader closes", async () => {
  const { filePath } = await fixture();
  const store = makeStore(filePath);
  await store.write({ sessions: [{ id: "selected", record: { tauThreadId: "selected", messages: ["kept"] } }] });
  await store.dispose();
  const cold = makeStore(filePath);
  await cold.loadMetadata();
  const bytes = await readFile(cold.databasePath);
  await rename(cold.databasePath, `${cold.databasePath}.replaced`);
  await writeFile(cold.databasePath, bytes);
  await expect(cold.loadSession("selected")).rejects.toThrow("replaced");
  await expect(cold.write({ models: [{ id: "default", models: ["new"] }] })).rejects.toThrow("replaced");
});

it("hydrates an explicit thousand-thread full listing without expiring individual history locks", async () => {
  const { filePath } = await fixture();
  const sessions = Array.from({ length: 1000 }, (_entry, index) => ({ tauThreadId: `thread-${index}`, messages: [`${index}:first`, `${index}:second`] }));
  await writeFile(filePath, JSON.stringify({ version: 1, sessions }));
  const store = makeStore(filePath);
  await store.loadMetadata();
  expect((await store.load())?.sessions.sort((left, right) => Number(left.tauThreadId.slice(7)) - Number(right.tauThreadId.slice(7)))).toEqual(sessions);
});

it("keeps a queued complete replacement's history identity through migration and later appends", async () => {
  const { filePath } = await fixture();
  await writeFile(filePath, JSON.stringify({ version: 1, sessions: [{ tauThreadId: "queued", messages: ["legacy"] }] }));
  const store = makeStore(filePath);
  const replacement = { tauThreadId: "queued", messages: ["accepted"] };
  await store.write({ sessions: [{ id: "queued", record: replacement }] });
  const record = (await store.loadSession("queued"))!;
  expect(record.messages).toEqual(["accepted"]);
  record.messages!.push("next");
  await store.write({ sessions: [{ id: "queued", record, appendOnly: true }] });
  expect((await makeStore(filePath).load())?.sessions[0]?.messages).toEqual(["accepted", "next"]);
});

it("normalizes usage only on selected hydration and rewrites raw cumulative rows before publishing its marker", async () => {
  const { filePath } = await fixture();
  const original = makeStore(filePath);
  await original.write({ sessions: ["selected", "unseen"].map(id => ({ id, record: { tauThreadId: id, messages: [], usageTurns: [{ cost: 10 }, { cost: 15 }] } })) });
  await original.dispose();
  const migrated = new SessionStorePersistence<Record, string>({ filePath, version: 1, immutableUsageTurns: true,
    decode: value => {
      const data = value as { sessions: Record[] };
      return { sessions: data.sessions.map(record => record.title === "migrated" || !record.usageTurns?.length ? record : {
        ...record, title: "migrated", usageTurns: [{ cost: 10 }, { cost: 5 }],
      }) };
    } });
  stores.push(migrated);
  const metadata = (await migrated.loadMetadata())!.sessions;
  expect(metadata.every(record => record.title === undefined && record.usageTurns?.length === 0)).toBe(true);
  await expect(migrated.write({ sessions: [{ id: "unseen", record: metadata.find(record => record.tauThreadId === "unseen")!, appendOnly: true }] })).rejects.toThrow("history is not loaded");
  const record = (await migrated.loadSession("selected"))!;
  expect(record.usageTurns).toEqual([{ cost: 10 }, { cost: 5 }]);
  await migrated.write({ sessions: [{ id: "selected", record, appendOnly: true }] });
  const persisted = (await makeStore(filePath).load())!.sessions;
  expect(persisted.find(entry => entry.tauThreadId === "selected")).toMatchObject({ title: "migrated", usageTurns: [{ cost: 10 }, { cost: 5 }] });
  expect(persisted.find(entry => entry.tauThreadId === "unseen")).toEqual({ tauThreadId: "unseen", messages: [], usageTurns: [{ cost: 10 }, { cost: 15 }] });
  await migrated.dispose();
  expect((await makeStore(filePath).load())!.sessions.find(entry => entry.tauThreadId === "selected")?.usageTurns).toEqual([{ cost: 10 }, { cost: 5 }]);
});

it("exports complete text pages from disk without hydrating or trusting the caller's catalog", async () => {
  const { filePath } = await fixture();
  const store = makeStore(filePath);
  const text = "x".repeat(63_999) + "😀𐐀 crystal " + "z".repeat(100_000);
  await store.write({ sessions: [{ id: "large", record: { tauThreadId: "large", updatedAt: 5,
    messages: [{ role: "notice", text: "hidden" }, { role: "assistant", textChunks: [text.slice(0, 64_000), text.slice(64_000)] }] } }] });
  await store.flushAndRelease();
  const reader = makeStore(filePath);
  await reader.loadMetadata();
  const catalog = await reader.threadTexts([], { protocol: 2, knownVersions: { gone: "old" }, maxChars: 0 });
  expect(catalog).toMatchObject({ threads: [], removed: ["gone"], catalog: [{ threadId: "large", updatedAt: 5 }] });
  const version = catalog.catalog![0]!.version;
  expect((await makeStore(filePath).threadTexts([], { protocol: 2 })).catalog![0]!.version).toBe(version);
  let cursor: string | undefined, result = "", pages = 0;
  do {
    const page = (await reader.threadTexts([], { protocol: 2, page: { threadId: "large", version, cursor } })).page!;
    expect(page.status).toBe("ok");
    expect(page.chunks.reduce((size, chunk) => size + chunk.text.length, 0)).toBeLessThanOrEqual(64_000);
    for (const chunk of page.chunks) {
      expect(chunk.messageId).toBe("1");
      expect(chunk.offset).toBe(result.length);
      expect(chunk.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
      result += chunk.text;
      expect(chunk.end).toBe(result === text);
    }
    cursor = page.nextCursor ?? undefined;
    expect(++pages).toBeLessThan(10);
  } while (cursor);
  expect(result).toBe(text);
  expect(reader.isUnloaded("large")).toBe(true);
});

it("invalidates in-flight pages for same-timestamp writes by another store and returns deletions from disk", async () => {
  const { filePath } = await fixture();
  const writer = makeStore(filePath);
  const saved = { tauThreadId: "same", updatedAt: 9, messages: [{ role: "user", text: "first " + "a".repeat(90_000) }] };
  await writer.write({ sessions: [{ id: "same", record: saved }] });
  const reader = makeStore(filePath);
  await reader.loadMetadata();
  const version = (await reader.threadTexts([], { protocol: 2 })).catalog![0]!.version;
  const first = (await reader.threadTexts([], { protocol: 2, page: { threadId: "same", version } })).page!;
  expect(first.nextCursor).not.toBeNull();
  await writer.write({ sessions: [{ id: "same", record: { ...saved, messages: [{ role: "user", text: "other text" }] } }] });
  const changed = await reader.threadTexts([], { protocol: 2, knownVersions: { same: version } });
  expect(changed.catalog![0]!.version).not.toBe(version);
  expect((await reader.threadTexts([], { protocol: 2, page: { threadId: "same", version, cursor: first.nextCursor! } })).page)
    .toMatchObject({ status: "changed", chunks: [] });
  await writer.write({ sessions: [{ id: "same" }] });
  expect(await reader.threadTexts([{ tauThreadId: "same", updatedAt: 9, messages: [] }], { protocol: 2, knownVersions: { same: version }, maxChars: 0 }))
    .toMatchObject({ catalog: [], removed: ["same"] });
  expect((await reader.threadTexts([], { protocol: 2, page: { threadId: "same", version } })).page!.status).toBe("missing");
});
