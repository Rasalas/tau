import { build } from "esbuild";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const root = fileURLToPath(new URL("..", import.meta.url));
await mkdir(join(root, ".scratch"), { recursive: true });
const directory = await mkdtemp(join(root, ".scratch", "session-performance-"));
const rounded = (value) => Math.round(value * 10) / 10;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), persistence: [], transcript: [] };
const failures = [];
let reader;

async function files(path) {
  return new Map(await Promise.all((await readdir(path)).filter((name) => name.endsWith(".json")).map(async (name) => {
    const info = await stat(join(path, name), { bigint: true });
    return [name, { stamp: `${info.ino}:${info.mtimeNs}`, size: Number(info.size) }];
  })));
}

try {
  // Bundled local modules, external installed packages: the same source under
  // test, without starting an app or reading any user's runtime configuration.
  await build({
    stdin: { contents: 'export { SessionStorePersistence } from "./kits/_shared/session-store-persistence.ts"; export { PersistedTranscriptReader } from "./src/main/persisted-transcript-reader.ts"; export { PI_AGENT_RUNTIME_ADAPTER } from "./src/main/runtime-adapters.ts";', resolveDir: root },
    outfile: join(directory, "subject.mjs"), bundle: true, platform: "node", format: "esm", packages: "external",
    alias: { "tau/host-extension": join(root, "src/main/host-extension-api.ts") },
  });
  await build({ entryPoints: [join(root, "src/main/persisted-transcript-worker.ts")], outfile: join(directory, "worker.mjs"), bundle: true, platform: "node", format: "esm", packages: "external" });
  const { SessionStorePersistence, PersistedTranscriptReader, PI_AGENT_RUNTIME_ADAPTER } = await import(pathToFileURL(join(directory, "subject.mjs")));
  for (const count of [10, 100, 1_000]) {
    const path = join(directory, `sessions-${count}.json`);
    const sessions = Array.from({ length: count }, (_, i) => ({
      tauThreadId: `thread-${i}`, cwd: directory, updatedAt: 1,
      messages: Array.from({ length: 40 }, (_message, j) => ({ role: j % 2 ? "assistant" : "user", text: `${i}:${j} ${"x".repeat(1_000)}`, timestamp: j })),
    }));
    await writeFile(path, JSON.stringify({ version: 1, sessions }));
    const store = new SessionStorePersistence({ filePath: path, version: 1, decode: (value) => value });
    const migrationStart = performance.now();
    await store.load();
    const migrationMs = performance.now() - migrationStart;
    const before = await files(`${path}.records`);
    const times = [], synchronous = [];
    for (let repeat = 0; repeat < 5; repeat++) {
      sessions[0].title = `changed-${repeat}`;
      const start = performance.now();
      const pending = store.write({ sessions: [{ id: sessions[0].tauThreadId, record: sessions[0] }] });
      synchronous.push(performance.now() - start);
      await pending;
      times.push(performance.now() - start);
    }
    const changed = [...await files(`${path}.records`)].filter(([name, info]) => before.get(name)?.stamp !== info.stamp);
    const rewrittenBytes = changed.reduce((sum, [, info]) => sum + info.size, 0);
    report.persistence.push({ threads: count, migrationMs: rounded(migrationMs), medianWriteMs: rounded(median(times)), medianSynchronousCallMs: rounded(median(synchronous)), changedFiles: changed.length, rewrittenBytes });
    if (changed.length !== 1 || rewrittenBytes > 64 * 1_024) failures.push(`${count} threads: one title change rewrote ${changed.length} files / ${rewrittenBytes} bytes`);
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
