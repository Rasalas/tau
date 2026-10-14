import { build } from "esbuild";
import { persistedTranscriptWorkerBuildOptions } from "./persisted-transcript-worker-build.mjs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const root = fileURLToPath(new URL("..", import.meta.url));
await mkdir(join(root, ".scratch"), { recursive: true });
const directory = await mkdtemp(join(root, ".scratch", "session-performance-"));
const rounded = (value) => Math.round(value * 10) / 10;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const report = { schemaVersion: 2, generatedAt: new Date().toISOString(), persistence: [], transcript: [] };
const failures = [];
let reader;

try {
  // Bundled local modules, external installed packages: the same source under
  // test, without starting an app or reading any user's runtime configuration.
  await build({
    stdin: { contents: 'export { SessionStorePersistence } from "./kits/_shared/session-store-persistence.ts"; export { PersistedTranscriptReader } from "./src/main/persisted-transcript-reader.ts"; export { PI_AGENT_RUNTIME_ADAPTER } from "./src/main/runtime-adapters.ts";', resolveDir: root },
    outfile: join(directory, "subject.mjs"), bundle: true, platform: "node", format: "esm", packages: "external",
    alias: { "tau/host-extension": join(root, "src/main/host-extension-api.ts") },
  });
  await build(persistedTranscriptWorkerBuildOptions(root, join(directory, "worker.mjs")));
  const { SessionStorePersistence, PersistedTranscriptReader, PI_AGENT_RUNTIME_ADAPTER } = await import(pathToFileURL(join(directory, "subject.mjs")));
  for (const count of [10, 100, 1_000]) {
    const path = join(directory, `sessions-${count}.json`);
    const sessions = Array.from({ length: count }, (_, i) => ({
      tauThreadId: `thread-${i}`, cwd: directory, updatedAt: 1,
      messages: Array.from({ length: 40 }, (_message, j) => ({ role: j % 2 ? "assistant" : "user", text: `${i}:${j} ${"x".repeat(1_000)}`, timestamp: j })),
    }));
    await writeFile(path, JSON.stringify({ version: 1, sessions }));
    const store = new SessionStorePersistence({ filePath: path, version: 1, decode: (value) => value });
    let audit;
    try {
      const migrationStart = performance.now();
      await store.load();
      const migrationMs = performance.now() - migrationStart;
      // Establish the caller's append-only array identity before measuring.
      await store.write({ sessions: [{ id: sessions[0].tauThreadId, record: sessions[0], appendOnly: true }] });
      // Fixture-only SQL triggers count actual writes, including a delete/reinsert
      // that would otherwise leave identical final payloads. No production hooks.
      audit = new DatabaseSync(store.databasePath);
      audit.exec("PRAGMA busy_timeout = 5000; CREATE TABLE benchmark_writes (entity TEXT NOT NULL)");
      for (const table of ["sessions", "messages", "usage_turns"]) {
        for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
          audit.exec(`CREATE TRIGGER benchmark_${table}_${operation} AFTER ${operation} ON ${table}
            BEGIN INSERT INTO benchmark_writes VALUES ('${table}'); END`);
        }
      }
      const times = [], synchronous = [];
      for (let repeat = 0; repeat < 5; repeat++) {
        sessions[0].title = `changed-${repeat}`;
        const start = performance.now();
        const pending = store.write({ sessions: [{ id: sessions[0].tauThreadId, record: sessions[0], appendOnly: true }] });
        synchronous.push(performance.now() - start);
        await pending;
        times.push(performance.now() - start);
      }
      const rowWrites = () => Object.fromEntries(audit.prepare("SELECT entity, count(*) AS count FROM benchmark_writes GROUP BY entity").all().map((row) => [row.entity, row.count]));
      const titleRowWrites = rowWrites();
      audit.exec("DELETE FROM benchmark_writes");
      sessions[0].messages.push({ role: "assistant", text: "one new message", timestamp: 41 });
      const appendStarted = performance.now();
      await store.write({ sessions: [{ id: sessions[0].tauThreadId, record: sessions[0], appendOnly: true }] });
      const appendMs = performance.now() - appendStarted;
      const appendRowWrites = rowWrites();
      report.persistence.push({ threads: count, migrationMs: rounded(migrationMs), medianWriteMs: rounded(median(times)), medianSynchronousCallMs: rounded(median(synchronous)), titleRowWrites, appendMs: rounded(appendMs), appendRowWrites });
      if (titleRowWrites.sessions !== 5 || titleRowWrites.messages || titleRowWrites.usage_turns) failures.push(`${count} threads: title changes rewrote history: ${JSON.stringify(titleRowWrites)}`);
      if (appendRowWrites.sessions !== 1 || appendRowWrites.messages !== 1 || appendRowWrites.usage_turns) failures.push(`${count} threads: append rewrote previous rows: ${JSON.stringify(appendRowWrites)}`);
    } finally {
      audit?.close();
      await store.dispose();
    }
  }
  reader = new PersistedTranscriptReader(pathToFileURL(join(directory, "worker.mjs")));
  for (const count of [200, 2_000, 20_000]) {
    const path = join(directory, `history-${count}.jsonl`);
    const timestamp = new Date().toISOString();
    const lines = [JSON.stringify({ type: "session", version: 3, id: `history-${count}`, timestamp, cwd: directory })];
    for (let i = 0; i < count; i++) lines.push(JSON.stringify({ type: "message", id: `entry-${i}`, parentId: i ? `entry-${i - 1}` : null, timestamp, message: { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: "x".repeat(1_000) }], timestamp: i + 1 } }));
    await writeFile(path, `${lines.join("\n")}\n`);
    const thread = { sessionId: `history-${count}`, cwd: directory, path };
    const options = { runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER, skillCommands: [] };
    const workerStartsBefore = reader.workerStarts;
    const start = performance.now();
    const first = await reader.page(thread, options);
    const coldMs = performance.now() - start;
    const built = reader.diagnostics.builds, mapped = reader.diagnostics.mappedRecords;
    const times = [];
    for (let repeat = 0; repeat < 5; repeat++) {
      const begin = performance.now();
      await reader.page(thread, options, first.olderCursor);
      times.push(performance.now() - begin);
    }
    const { builds, mappedRecords, pageRecords, cacheBytes } = reader.diagnostics;
    const workerStarts = reader.workerStarts - workerStartsBefore;
    report.transcript.push({ entries: count, coldMs: rounded(coldMs), workerStarts, medianOlderPageMs: rounded(median(times)), returnedMessages: first.messages.length, warmBuilds: builds - built, warmMappedRecords: mappedRecords - mapped, pageRecords, cacheBytes });
    if (builds !== built || mappedRecords !== mapped || first.messages.length !== 40 || pageRecords !== 40 || cacheBytes > 64 * 1_024 * 1_024) failures.push(`${count} entries: warm paging exceeded its structural budget`);
    if (count === 200 && workerStarts !== 0) failures.push("Small history unnecessarily started a transcript worker");
  }
  await mkdir(join(root, "reports"), { recursive: true });
  const output = join(root, "reports/session-performance-report.json");
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`Session performance report: ${output}`);
  if (process.argv.includes("--check") && failures.length) throw new Error(failures.join("\n"));
} finally {
  await reader?.dispose();
  await rm(directory, { recursive: true, force: true });
}
