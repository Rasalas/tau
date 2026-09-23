import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile as writeTextFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { evaluateHostBudgets } from "./host-budget.mjs";

const root = process.cwd();
const mode = process.argv.includes("--full") ? "full" : "safe";
const check = process.argv.includes("--check");
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : join(root, "reports", `host-${mode}-report.json`);
const alternate = await mkdtemp(join(tmpdir(), "tau-host-benchmark-"));
const historyPath = join(alternate, "projects.json");

// Linear interpolation (Hyndman-Fan type 7), like the renderer benchmark.
function summarize(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const at = (percentile) => {
    if (sorted.length === 0) return 0;
    const position = (sorted.length - 1) * percentile;
    const lower = Math.floor(position);
    const upper = Math.min(sorted.length - 1, lower + 1);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  };
  return { median: at(0.5), p95: at(0.95), maximum: sorted.at(-1) ?? 0 };
}

/** Cold starts per report; one start is a single sample, not a distribution. */
const HOST_RUNS = Math.max(1, Number(process.env.TAU_HOST_BENCH_RUNS ?? 3));
/** User turns in the long metadata fixture; each adds a tool call, its result and an answer. */
const LONG_THREAD_TURNS = Math.max(1, Number(process.env.TAU_HOST_BENCH_LONG_TURNS ?? 5_000));
const METADATA_SAMPLES = 20;

/** One thread of `turns` user turns, each with a tool call, its result and an answer. */
function writeThread(SessionManager, cwd, sessionDir, turns, provider, model) {
  const manager = SessionManager.create(cwd, sessionDir);
  const at = Date.now();
  const assistant = (content, index) => ({
    role: "assistant", content, api: "openai-completions", provider, model,
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: at + index,
  });
  for (let turn = 0; turn < turns; turn += 1) {
    const index = turn * 4;
    const callId = `call-${turn}`;
    manager.appendMessage({ role: "user", content: [{ type: "text", text: `Question ${turn}: what does file ${turn} contain?` }], timestamp: at + index });
    manager.appendMessage(assistant([{ type: "toolCall", id: callId, name: "bash", arguments: { command: `cat file-${turn}.txt` } }], index + 1));
    manager.appendMessage({ role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: `line ${turn}\n`.repeat(8) }], isError: false, timestamp: at + index + 2 });
    manager.appendMessage(assistant([{ type: "text", text: `File ${turn} holds eight lines that each name the turn.` }], index + 3));
  }
  return { path: manager.getSessionFile(), entries: manager.getEntries().length };
}

/**
 * Model and thinking-level changes in a short and a long thread. Its own agent
 * directory: a model change needs a provider with a key, and must not touch
 * the settings of whoever runs the benchmark.
 */
async function measureMetadataCommands(PiHost, ProjectHistory, SessionManager) {
  const agentDir = join(alternate, "metadata-agent");
  const sessionDir = join(alternate, "metadata-sessions");
  const provider = "tau-bench";
  await mkdir(agentDir, { recursive: true });
  await writeTextFile(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      [provider]: {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        apiKey: "benchmark",
        models: [{ id: "bench-a", reasoning: true }, { id: "bench-b", reasoning: true }],
      },
    },
  }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const threads = {
    short: writeThread(SessionManager, alternate, sessionDir, 2, provider, "bench-a"),
    long: writeThread(SessionManager, alternate, sessionDir, LONG_THREAD_TURNS, provider, "bench-a"),
  };
  const history = new ProjectHistory(join(alternate, "metadata-projects.json"));
  await history.load();
  const host = new PiHost(alternate, () => {}, history, mode === "safe", false);
  const samples = [];
  try {
    await host.start();
    for (const [length, thread] of Object.entries(threads)) {
      await host.switchSession(thread.path);
      // One untimed round first: the first change of a thread warms the model catalog.
      for (let run = -1; run < METADATA_SAMPLES; run += 1) {
        const modelStarted = performance.now();
        await host.setModel(provider, run % 2 === 0 ? "bench-b" : "bench-a");
        const modelMs = performance.now() - modelStarted;
        const thinkingStarted = performance.now();
        await host.setThinkingLevel(run % 2 === 0 ? "high" : "low");
        const thinkingMs = performance.now() - thinkingStarted;
        if (run < 0) continue;
        samples.push({ scenario: `set-model-${length}`, entries: thread.entries, durationMs: modelMs });
        samples.push({ scenario: `set-thinking-${length}`, entries: thread.entries, durationMs: thinkingMs });
      }
    }
  } finally {
    await host.dispose();
    await history.flush();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  return {
    entries: { short: threads.short.entries, long: threads.long.entries },
    samples,
    summaries: Object.fromEntries([...new Set(samples.map((sample) => sample.scenario))].map((scenario) => [
      scenario,
      summarize(samples.filter((sample) => sample.scenario === scenario).map((sample) => sample.durationMs)),
    ])),
  };
}

try {
  execFileSync("git", ["init", "-b", "main", alternate], { stdio: "ignore" });
  await writeTextFile(join(alternate, "README.md"), "# benchmark\n");
  execFileSync("git", ["-C", alternate, "add", "README.md"], { stdio: "ignore" });
  execFileSync("git", ["-C", alternate, "-c", "user.name=Tau Benchmark", "-c", "user.email=tau@example.invalid", "commit", "-m", "fixture"], { stdio: "ignore" });
  const [{ PiHost }, { ProjectHistory }, { SessionManager }, { compactHeap }] = await Promise.all([
    import(pathToFileURL(join(root, "dist-electron", "main", "pi-host.js")).href),
    import(pathToFileURL(join(root, "dist-electron", "main", "project-history.js")).href),
    import("@earendil-works/pi-coding-agent"),
    import(pathToFileURL(join(root, "dist-electron", "main", "host-idle-compaction.js")).href),
  ]);
  const sessionDir = join(alternate, "sessions");
  const sessionPaths = ["First fixture", "Second fixture"].map((name, index) => {
    const manager = SessionManager.create(alternate, sessionDir);
    manager.appendMessage({ role: "user", content: [{ type: "text", text: `${name} ${index}` }], timestamp: Date.now() + index });
    return manager.getSessionFile();
  });
  if (sessionPaths.some((path) => !path)) throw new Error("Could not create persisted benchmark sessions");
  const wallClock = [];
  let phases = [];
  let background = [];
  let idleHeapMiB;
  for (let hostRun = 0; hostRun < HOST_RUNS; hostRun += 1) {
    const history = new ProjectHistory(historyPath);
    await history.load();
    const host = new PiHost(root, () => {}, history, mode === "safe", false);
    const started = performance.now();
    await host.start();
    wallClock.push({ scenario: "bootstrap", durationMs: performance.now() - started });
    const firstSwitchStarted = performance.now();
    await host.switchSession(sessionPaths[0]);
    wallClock.push({ scenario: "cold-switch", durationMs: performance.now() - firstSwitchStarted });
    for (let run = 0; run < 4; run += 1) {
      const path = sessionPaths[(run + 1) % sessionPaths.length];
      const prewarmStarted = performance.now();
      await host.prewarmSession(path);
      wallClock.push({ scenario: "prewarm", durationMs: performance.now() - prewarmStarted });
      const switchStarted = performance.now();
      await host.switchSession(path);
      wallClock.push({ scenario: "warm-switch", durationMs: performance.now() - switchStarted });
    }
    // A thread whose runtime was released for idleness reopens from its session file.
    for (const path of sessionPaths) {
      await host.threads.releaseIdle(0);
      const reopenStarted = performance.now();
      await host.switchSession(path);
      wallClock.push({ scenario: "reopen-released", durationMs: performance.now() - reopenStarted });
    }
    // What the host holds once it went quiet, as the host process's idle compaction leaves it.
    compactHeap();
    idleHeapMiB = process.memoryUsage().heapUsed / 1024 / 1024;
    await host.dispose();
    await history.flush();
    // Phases describe one host; the last start stands for the report.
    phases = host.getLifecycleMeasurements();
    background = host.getBackgroundLifecycleMeasurements();
  }
  const metadata = await measureMetadataCommands(PiHost, ProjectHistory, SessionManager);
  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    mode,
    wallClock,
    summaries: Object.fromEntries([...new Set(wallClock.map((sample) => sample.scenario))].map((scenario) => {
      const samples = wallClock.filter((sample) => sample.scenario === scenario).map((sample) => sample.durationMs);
      // The first start of a process is the only cold one; later hosts reuse the SDK's resource cache.
      return [scenario, scenario === "bootstrap" ? { ...summarize(samples), cold: samples[0] } : summarize(samples)];
    })),
    hostRuns: HOST_RUNS,
    idleHeapMiB,
    phases,
    background,
    metadata,
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  if (check) {
    const budgets = JSON.parse(await readFile(join(root, "scripts", "performance-budgets.json"), "utf8"));
    const failures = evaluateHostBudgets(report, budgets);
    if (failures.length > 0) {
      console.error(`Host budget failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
      process.exitCode = 1;
    }
  }
  console.log(`Host report: ${output}`);
} finally {
  await rm(alternate, { recursive: true, force: true });
}
