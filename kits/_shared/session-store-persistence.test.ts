import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { SessionStorePersistence } from "./session-store-persistence.js";

it("merges independent process snapshots under the shared file's lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-session-writers-"));
  const filePath = join(directory, "sessions.json");
  const bundle = join(directory, "persistence.cjs");
  const children: ReturnType<typeof start>[] = [];
  function start(prefix: string) {
    const child = spawn(process.execPath, ["-e", `
      const { SessionStorePersistence } = require(process.argv[1]);
      const store = new SessionStorePersistence({ filePath: process.argv[2], version: 1, decode: value => value });
      const sessions = [];
      (async () => {
        await store.load();
        process.once('message', async () => {
          try {
            for (let i = 0; i < 10; i++) {
              sessions.push({ tauThreadId: process.argv[3] + i });
              await store.write({ sessions: [{ id: sessions.at(-1).tauThreadId, record: sessions.at(-1) }] });
            }
          } catch (error) {
            console.error(error);
            process.exitCode = 1;
          } finally {
            process.disconnect();
          }
        });
        process.send('ready');
      })().catch(error => { console.error(error); process.exit(1); });
    `, bundle, filePath, prefix], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let errors = "";
    child.stderr!.on("data", (data) => { errors += String(data); });
    const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
    const ready = new Promise<void>((done, fail) => {
      child.once("message", () => done());
      child.once("error", fail);
      child.once("exit", () => fail(new Error(errors || "Writer exited before ready")));
    });
    return { child, exited, ready, errors: () => errors };
  }
  try {
    await build({
      entryPoints: [fileURLToPath(new URL("./session-store-persistence.ts", import.meta.url))],
      outfile: bundle,
      bundle: true,
      platform: "node",
      format: "cjs",
      alias: { "tau/host-extension": resolve("src/main/host-extension-api.ts") },
    });
    children.push(start("first-"), start("second-"));
    await Promise.all(children.map((writer) => writer.ready));
    for (const writer of children) writer.child.send("write");
    const codes = await Promise.all(children.map((writer) => writer.exited));
    expect(codes, children.map((writer) => writer.errors()).join("\n")).toEqual([0, 0]);
    const reloaded = new SessionStorePersistence<{ tauThreadId: string }>({ filePath, version: 1, decode: (value) => value as { sessions: Array<{ tauThreadId: string }> } });
    expect((await reloaded.load())?.sessions.map((record) => record.tauThreadId).sort()).toEqual(
      ["first-", "second-"].flatMap((prefix) => Array.from({ length: 10 }, (_, i) => `${prefix}${i}`)),
    );
  } finally {
    for (const writer of children) if (writer.child.exitCode === null && writer.child.signalCode === null) writer.child.kill();
    await Promise.all(children.map((writer) => writer.exited));
    await rm(directory, { recursive: true, force: true });
  }
});

function makeStore(filePath: string) {
  return new SessionStorePersistence<{ tauThreadId: string; title?: string; messages?: string[] }, string>({
    filePath, version: 1,
    decode: (value) => value as { sessions: Array<{ tauThreadId: string; title?: string; messages?: string[] }>; models?: Record<string, string[]> },
  });
}

it("migrates legacy data before publishing its marker, retaining a recovery copy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-session-migration-"));
  const filePath = join(directory, "sessions.json");
  try {
    const legacy = JSON.stringify({ version: 1, sessions: [{ tauThreadId: "../thread", title: "kept" }], models: { work: ["model"] } });
    await writeFile(filePath, legacy);
    const store = makeStore(filePath);
    expect(await store.load()).toEqual({ sessions: [{ tauThreadId: "../thread", title: "kept" }], models: { work: ["model"] } });
    expect(await readFile(`${filePath}.legacy`, "utf8")).toBe(legacy);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({ version: 2, layout: "thread-records" });
    expect(await makeStore(filePath).load()).toEqual(await store.load());
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("retries a migration interrupted before marker publication without retaining partial records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-session-recovery-"));
  const filePath = join(directory, "sessions.json");
  try {
    await makeStore(filePath).write({ sessions: [{ id: "partial", record: { tauThreadId: "partial" } }] });
    await writeFile(filePath, JSON.stringify({ version: 1, sessions: [{ tauThreadId: "actual" }] }));
    expect((await makeStore(filePath).load())?.sessions).toEqual([{ tauThreadId: "actual" }]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("keeps a newer legacy schema readable while refusing writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-session-schema-"));
  const filePath = join(directory, "sessions.json");
  try {
    const original = JSON.stringify({ version: 99, sessions: [{ tauThreadId: "future" }] });
    await writeFile(filePath, original);
    const store = makeStore(filePath);
    expect((await store.load())?.sessions).toEqual([{ tauThreadId: "future" }]);
    await expect(store.write({ sessions: [{ id: "future" }] })).rejects.toThrow("Unsupported");
    expect(await readFile(filePath, "utf8")).toBe(original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("does not resurrect deletions or overwrite another writer's untouched threads and models", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-session-stale-"));
  const filePath = join(directory, "sessions.json");
  try {
    const first = makeStore(filePath);
    await first.write({ sessions: [{ id: "deleted", record: { tauThreadId: "deleted" } }] });
    const stale = makeStore(filePath);
    await stale.load();
    await first.write({ sessions: [{ id: "deleted" }], models: [{ id: "first", models: ["a"] }] });
    const record = { tauThreadId: "other", title: "frozen" };
    const queued = stale.write({ sessions: [{ id: "other", record }], models: [{ id: "second", models: ["b"] }] });
    record.title = "later mutation";
    await queued;
    expect(await makeStore(filePath).load()).toEqual({ sessions: [{ tauThreadId: "other", title: "frozen" }], models: { first: ["a"], second: ["b"] } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("rewrites only the touched thread when the store contains megabytes of unrelated transcripts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-session-volume-"));
  const filePath = join(directory, "sessions.json");
  try {
    const store = makeStore(filePath);
    const sessions = Array.from({ length: 80 }, (_, i) => ({ tauThreadId: `thread-${i}`, messages: ["x".repeat(64 * 1024)] }));
    await store.write({ sessions: sessions.map((record) => ({ id: record.tauThreadId, record })) });
    const paths = [filePath, ...(await readdir(`${filePath}.records`)).map((name) => join(`${filePath}.records`, name))];
    const before = await Promise.all(paths.map((path) => stat(path)));
    await store.write({ sessions: [{ id: "thread-0", record: { ...sessions[0]!, title: "changed" } }] });
    const after = await Promise.all(paths.map((path) => stat(path)));
    const rewritten = after.filter((entry, i) => entry.ino !== before[i]!.ino);
    expect(before.reduce((sum, entry) => sum + entry.size, 0)).toBeGreaterThan(5 * 1024 * 1024);
    expect(rewritten).toHaveLength(1);
    expect(rewritten.reduce((sum, entry) => sum + entry.size, 0)).toBeLessThan(70 * 1024);
    expect((await makeStore(filePath).load())?.sessions.find((record) => record.tauThreadId === "thread-0")?.title).toBe("changed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("refuses to downgrade a newer touched record without blocking independent IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-session-record-schema-"));
  const filePath = join(directory, "sessions.json");
  try {
    const store = makeStore(filePath);
    await store.write({ sessions: [{ id: "future", record: { tauThreadId: "future" } }] });
    const path = join(`${filePath}.records`, (await readdir(`${filePath}.records`))[0]!);
    const original = JSON.stringify({ version: 99, sessions: [{ tauThreadId: "future", title: "new schema" }] });
    await writeFile(path, original);
    await expect(store.write({ sessions: [{ id: "future" }] })).rejects.toThrow("version 99");
    await store.write({ sessions: [{ id: "independent", record: { tauThreadId: "independent" } }] });
    expect(await readFile(path, "utf8")).toBe(original);
    expect((await makeStore(filePath).load())?.sessions).toHaveLength(2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("refuses a published layout whose required record directory is missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-session-missing-records-"));
  const filePath = join(directory, "sessions.json");
  try {
    const loaded = makeStore(filePath);
    await loaded.load();
    expect((await stat(`${filePath}.records`)).isDirectory()).toBe(true);
    const marker = await readFile(filePath, "utf8");
    await rm(`${filePath}.records`, { recursive: true });
    await expect(makeStore(filePath).load()).rejects.toThrow();
    await expect(loaded.write({ sessions: [{ id: "new", record: { tauThreadId: "new" } }] })).rejects.toThrow();
    await expect(stat(`${filePath}.records`)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(filePath, "utf8")).toBe(marker);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("rejects session records stored under a different thread's key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-session-wrong-key-"));
  const filePath = join(directory, "sessions.json");
  try {
    await makeStore(filePath).write({ sessions: [{ id: "original", record: { tauThreadId: "original" } }] });
    const path = join(`${filePath}.records`, (await readdir(`${filePath}.records`))[0]!);
    await writeFile(path, JSON.stringify({ version: 1, sessions: [{ tauThreadId: "other" }] }));
    await expect(makeStore(filePath).load()).rejects.toThrow("storage key");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
