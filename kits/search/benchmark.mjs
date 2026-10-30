/** Synthetic, reproducible corpus. Never opens Tau's sessions or starts the app.
 * Run from the repo root: node kits/search/benchmark.mjs [threads=500] [messages=150]
 * Uses the existing esbuild dependency to load TypeScript into a private temp dir.
 */
import { build } from "esbuild";
import { mkdtemp, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const count = (value, fallback) => /^\d+$/u.test(value ?? "") && Number(value) > 0 ? Number(value) : fallback;
const threadCount = count(process.argv[2], 500);
const messageCount = count(process.argv[3], 150);
const root = await mkdtemp(join(tmpdir(), "tau-search-benchmark-"));
try {
  const modulePath = join(root, "index.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("./persistent-index.ts", import.meta.url))], outfile: modulePath, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
  const { PersistentMessageIndex } = await import(pathToFileURL(modulePath).href);
  const identities = [];
  let sourceBytes = 0;
  const words = ["workspace", "refactor", "parser", "authentication", "release", "component", "typescript", "Überprüfung", "東京", "recovery", "message", "network", "schema", "isolation"];
  const row = (text, role) => JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });
  for (let thread = 0; thread < threadCount; thread += 1) {
    const path = join(root, `session-${thread}.jsonl`);
    const file = await open(path, "wx", 0o600);
    try {
      for (let message = 0; message < messageCount; message += 1) {
        const body = Array.from({ length: 220 }, (_, at) => words[(thread * 7 + message * 3 + at * 11) % words.length]).join(" ");
        const text = message === Math.floor(messageCount / 2) && thread % 97 === 0 ? `${body} benchmarkNeedle middle beacon` : body;
        await file.writeFile(row(text, message % 2 ? "assistant" : "user") + "\n");
      }
      if (thread % 149 === 0) await file.writeFile(row(`${"filler ".repeat(350_000)} giantMiddleNeedle ${"ending ".repeat(350_000)}`, "assistant") + "\n");
    } finally { await file.close(); }
    sourceBytes += (await stat(path)).size;
    identities.push({ source: "pi", id: `thread-${thread}`, path });
  }
  const stateDir = join(root, "state");
  const disk = new PersistentMessageIndex(stateDir);
  const run = async (name, index, token) => {
    const start = performance.now();
    const cpu = process.cpuUsage();
    let matches = 0;
    for (const identity of identities) if (await index.searchPi(identity, [token.toLowerCase()])) matches += 1;
    const used = process.cpuUsage(cpu);
    return { name, matches, milliseconds: Math.round(performance.now() - start), cpuMilliseconds: Math.round((used.user + used.system) / 1000), rssMiB: Math.round(process.memoryUsage().rss / 2 ** 20), ...index.stats };
  };
  const results = [];
  results.push(await run("cold", disk, "benchmarkNeedle"));
  results.push(await run("warm", disk, "benchmarkNeedle"));
  const restarted = new PersistentMessageIndex(stateDir);
  results.push(await run("restart", restarted, "giantMiddleNeedle"));
  await writeFile(identities[0].path, row("replacementOnlyNeedle", "user"));
  results.push(await run("one file changed", restarted, "replacementOnlyNeedle"));
  let indexBytes = 0;
  for (const name of await readdir(disk.directory)) indexBytes += (await stat(join(disk.directory, name))).size;
  process.stdout.write(JSON.stringify({ threadCount, messageCount, sourceMiB: Math.round(sourceBytes / 2 ** 20), indexMiB: Math.round(indexBytes / 2 ** 20), results }, null, 2) + "\n");
} finally { await rm(root, { recursive: true, force: true }); }
