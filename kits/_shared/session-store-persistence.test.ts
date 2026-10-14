import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { SessionStorePersistence } from "./session-store-persistence.js";

type Record = { tauThreadId: string; title?: string; messages?: unknown[]; usageTurns?: unknown[] };
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
        try { for(let i=0;i<10;i++) await store.write({sessions:[{id:process.argv[3]+i,record:{tauThreadId:process.argv[3]+i}}]}); }
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
  const old = { text: "x".repeat(1024 * 1024), toJSON() { serializations++; return { text: this.text }; } };
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
});

it.each(["missing", "corrupt"])("never imports stale backups when a published database is %s", async (damage) => {
  const { filePath } = await fixture();
  await writeFile(filePath, JSON.stringify({ version: 1, sessions: [{ tauThreadId: "old" }] }));
  const store = makeStore(filePath); await store.load(); await store.dispose();
  if (damage === "missing") await rm(store.databasePath); else await writeFile(store.databasePath, "not a database");
  await expect(makeStore(filePath).load()).rejects.toThrow();
  expect(JSON.parse(await readFile(filePath, "utf8")).layout).toBe("sqlite-sessions");
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

it("persists usage normalization from an existing SQLite record before marking it migrated", async () => {
  const { filePath } = await fixture();
  const original = makeStore(filePath);
  await original.write({ sessions: [{ id: "thread", record: { tauThreadId: "thread", messages: [], usageTurns: [{ cost: 10 }, { cost: 15 }] } }] });
  await original.dispose();
  const migrated = new SessionStorePersistence<Record, string>({ filePath, version: 1, immutableUsageTurns: true,
    decode: (value) => {
      const data = value as { sessions: Record[] };
      return { sessions: data.sessions.map((record) => record.title === "migrated" ? record : {
        ...record, title: "migrated", usageTurns: [{ cost: 10 }, { cost: 5 }],
      }) };
    } });
  stores.push(migrated);
  const record = (await migrated.load())!.sessions[0]!;
  await migrated.write({ sessions: [{ id: "thread", record, appendOnly: true }] });
  await migrated.dispose();
  expect((await makeStore(filePath).load())!.sessions[0]!.usageTurns).toEqual([{ cost: 10 }, { cost: 5 }]);
});
