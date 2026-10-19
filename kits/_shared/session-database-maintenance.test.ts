import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { reclaimDue, SESSION_DATABASE_MAINTENANCE, SessionStorePersistence, type SessionDatabaseMaintenance } from "./session-store-persistence.js";

type Record = { tauThreadId: string; messages?: unknown[] };
const directories: string[] = [];
const stores: SessionStorePersistence<Record>[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.dispose()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tau-sqlite-maintenance-"));
  directories.push(directory);
  return { directory, filePath: join(directory, "sessions.json") };
}
function makeStore(filePath: string, maintenance: Partial<SessionDatabaseMaintenance> = {}) {
  const store = new SessionStorePersistence<Record>({ filePath, version: 1, decode: (value) => value as { sessions: Record[] }, maintenance });
  stores.push(store);
  return store;
}
function query<T>(filePath: string, action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(`${filePath}.sqlite`);
  try { return action(db); } finally { db.close(); }
}
const pragma = (filePath: string, name: string) => query(filePath, (db) => Number(db.prepare(`PRAGMA ${name}`).get()![name]));
const fileSize = async (filePath: string) => (await stat(`${filePath}.sqlite`)).size + await stat(`${filePath}.sqlite-wal`).then((info) => info.size, () => 0);
const big = (id: string): Record => ({ tauThreadId: id, messages: ["x".repeat(200_000)] });
const ids = Array.from({ length: 20 }, (_, index) => `thread-${index}`);
const fill = (store: SessionStorePersistence<Record>) => store.write({ sessions: ids.map((id) => ({ id, record: big(id) })) });
const empty = (store: SessionStorePersistence<Record>, keep = 2) => store.write({ sessions: ids.slice(keep).map((id) => ({ id })) });
async function until(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) { if (await check()) return; await new Promise((done) => setTimeout(done, 25)); }
  throw new Error("Condition was not met in time");
}
/** A database as the previous version made it: no auto_vacuum, with free pages left by deleted threads. */
async function legacyDatabase(filePath: string) {
  const first = makeStore(filePath);
  await fill(first);
  await empty(first);
  await first.dispose();
  query(filePath, (db) => db.exec("PRAGMA auto_vacuum = 0; VACUUM;"));
  query(filePath, (db) => db.exec("CREATE TABLE scratch (v TEXT); INSERT INTO scratch VALUES (zeroblob(3000000)); DROP TABLE scratch;"));
  expect(pragma(filePath, "auto_vacuum")).toBe(0);
  expect(pragma(filePath, "freelist_count")).toBeGreaterThan(500);
}

it("creates new databases with incremental auto_vacuum", async () => {
  const { filePath } = await fixture();
  await makeStore(filePath).write({ sessions: [{ id: "a", record: { tauThreadId: "a" } }] });
  expect(pragma(filePath, "auto_vacuum")).toBe(2);
});

it("gives space back on its own after threads were deleted and the store went idle", async () => {
  const { filePath } = await fixture();
  const store = makeStore(filePath, { idleMs: 20, minIntervalMs: 0, minBytes: 1_000_000 });
  await fill(store);
  const full = await fileSize(filePath);
  await empty(store);
  expect(pragma(filePath, "freelist_count")).toBeGreaterThan(500);
  await until(async () => (await store.databaseStatus()).reclaimableBytes === 0 && (await fileSize(filePath)) < full / 4);
  const status = await store.databaseStatus();
  expect(status.lastReclaim?.bytes).toBeGreaterThan(2_000_000);
  expect(pragma(filePath, "freelist_count")).toBe(0);
  expect((await makeStore(filePath).load())?.sessions.map((record) => record.tauThreadId).sort()).toEqual(ids.slice(0, 2));
});

it("leaves a few free pages alone below the thresholds", async () => {
  const { filePath } = await fixture();
  const store = makeStore(filePath, { idleMs: 20, minIntervalMs: 0 });
  await fill(store);
  await empty(store);
  const free = pragma(filePath, "freelist_count");
  expect((await store.reclaim(false)).reclaimedBytes).toBe(0);
  expect(pragma(filePath, "freelist_count")).toBe(free);
  expect((await store.reclaim(true)).reclaimedBytes).toBeGreaterThan(2_000_000);
});

it("converts a database from before auto_vacuum once, when idle", async () => {
  const { filePath } = await fixture();
  await legacyDatabase(filePath);
  const before = await fileSize(filePath);
  const store = makeStore(filePath, { minBytes: 1_000_000 });
  await store.load();
  expect(pragma(filePath, "auto_vacuum")).toBe(0);
  const status = await store.reclaim(false);
  expect(pragma(filePath, "auto_vacuum")).toBe(2);
  expect(status.reclaimedBytes).toBeGreaterThan(2_000_000);
  expect(await fileSize(filePath)).toBeLessThan(before / 4);
  expect((await store.load())?.sessions).toHaveLength(2);
});

it("adds no maintenance work and no live timer to loading the store", async () => {
  const { filePath } = await fixture();
  await legacyDatabase(filePath);
  const store = makeStore(filePath);
  const operations: string[] = [];
  const target = store as unknown as { request(operation: string, values?: object): Promise<unknown>; maintenanceTimer?: ReturnType<typeof setTimeout> };
  const original = target.request.bind(store);
  target.request = (operation, values) => { operations.push(operation); return original(operation, values); };
  await store.load();
  expect(operations.filter((operation) => /^(database-status|convert|reclaim)/.test(operation))).toEqual([]);
  expect(pragma(filePath, "auto_vacuum")).toBe(0);
  expect(target.maintenanceTimer?.hasRef()).toBe(false);
});

it("does not convert the file while a write is pending", async () => {
  const { filePath } = await fixture();
  await legacyDatabase(filePath);
  const store = makeStore(filePath);
  await store.load();
  const queued = store.reclaim(true);
  const write = store.write({ sessions: [{ id: "late", record: { tauThreadId: "late" } }] });
  expect(await queued).toMatchObject({ deferred: true, reclaimedBytes: 0 });
  await write;
  expect(pragma(filePath, "auto_vacuum")).toBe(0);
  expect((await store.reclaim(true)).deferred).toBeUndefined();
  expect(pragma(filePath, "auto_vacuum")).toBe(2);
});

it("stops returning pages between steps when a write arrives", async () => {
  const { filePath } = await fixture();
  const store = makeStore(filePath, { stepBytes: 4096 });
  await fill(store);
  await empty(store);
  const target = store as unknown as { request(operation: string, values?: object): Promise<unknown> };
  const original = target.request.bind(store);
  const operations: string[] = [];
  let later: Promise<void> | undefined;
  target.request = async (operation, values) => {
    const value = await original(operation, values);
    operations.push(operation);
    if (operation === "reclaim-step" && !later) later = store.write({ sessions: [{ id: "later", record: { tauThreadId: "later" } }] });
    return value;
  };
  const stopped = await store.reclaim(true);
  await later;
  expect(stopped.deferred).toBe(true);
  expect(operations.filter((operation) => operation === "reclaim-step")).toHaveLength(1);
  expect(pragma(filePath, "freelist_count")).toBeGreaterThan(500);
  target.request = original;
  expect((await store.reclaim(true)).deferred).toBeUndefined();
  expect(pragma(filePath, "freelist_count")).toBe(0);
});

it("applies the default thresholds of 8 MB and a quarter of the file", () => {
  const page = { pageSize: 4096 };
  const pages = (megabytes: number) => Math.round(megabytes * 1024 * 1024 / 4096);
  expect(SESSION_DATABASE_MAINTENANCE.minBytes).toBe(8 * 1024 * 1024);
  expect(reclaimDue({ ...page, pageCount: pages(20), freePages: pages(7) }, SESSION_DATABASE_MAINTENANCE)).toBe(false);
  expect(reclaimDue({ ...page, pageCount: pages(100), freePages: pages(9) }, SESSION_DATABASE_MAINTENANCE)).toBe(false);
  expect(reclaimDue({ ...page, pageCount: pages(30), freePages: pages(9) }, SESSION_DATABASE_MAINTENANCE)).toBe(true);
});

async function migrate(filePath: string) {
  await writeFile(filePath, JSON.stringify({ version: 1, sessions: [{ tauThreadId: "old", messages: ["kept"] }] }));
  const store = makeStore(filePath, { legacyGraceMs: 0 });
  await store.load();
  await store.dispose();
  expect(existsSync(`${filePath}.pre-sqlite`)).toBe(true);
}

it("keeps the pre-SQLite files through the grace period and removes them afterwards", async () => {
  const { filePath } = await fixture();
  await migrate(filePath);
  const waiting = makeStore(filePath, { legacyGraceMs: 7 * 86_400_000 });
  await waiting.reclaim();
  expect(existsSync(`${filePath}.pre-sqlite`)).toBe(true);
  const old = new Date(Date.now() - 8 * 86_400_000);
  await utimes(`${filePath}.pre-sqlite`, old, old);
  await waiting.reclaim();
  expect(existsSync(`${filePath}.pre-sqlite`)).toBe(false);
  expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ version: 4, layout: "sqlite-sessions" });
});

it("removes per-thread record files but nothing it did not write", async () => {
  const { filePath } = await fixture();
  const directory = `${filePath}.records`;
  await mkdir(directory);
  const hash = createHash("sha256").update("old").digest("hex");
  await writeFile(filePath, JSON.stringify({ version: 2, layout: "thread-records" }));
  await writeFile(join(directory, `session-${hash}.json`), JSON.stringify({ version: 1, sessions: [{ tauThreadId: "old", messages: ["kept"] }] }));
  await writeFile(join(directory, "notes.txt"), "mine");
  const store = makeStore(filePath, { legacyGraceMs: 0 });
  await store.load();
  await store.reclaim();
  expect(await readdir(directory)).toEqual(["notes.txt"]);
  expect(existsSync(`${filePath}.pre-sqlite`)).toBe(false);
});

it("keeps the pre-SQLite files while the migration is not recorded", async () => {
  const { filePath } = await fixture();
  await migrate(filePath);
  query(filePath, (db) => db.exec("DELETE FROM store_meta WHERE key = 'import_digest'"));
  const store = makeStore(filePath, { legacyGraceMs: 0 });
  await store.reclaim();
  expect(existsSync(`${filePath}.pre-sqlite`)).toBe(true);
});

it("reports size without creating a database or migrating", async () => {
  const { filePath } = await fixture();
  await writeFile(filePath, JSON.stringify({ version: 1, sessions: [] }));
  const store = makeStore(filePath);
  expect(await store.databaseStatus()).toEqual({ sizeBytes: 0, reclaimableBytes: 0 });
  expect(await store.reclaim()).toEqual({ sizeBytes: 0, reclaimableBytes: 0 });
  expect(existsSync(`${filePath}.sqlite`)).toBe(false);
});
