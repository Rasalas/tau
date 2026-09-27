import { execFileSync } from "node:child_process";
import { utimesSync } from "node:fs";
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
/** User turns in the long thread fixtures; each adds a tool call, its result and an answer. */
const LONG_THREAD_TURNS = Math.max(1, Number(process.env.TAU_HOST_BENCH_LONG_TURNS ?? 5_000));
const METADATA_SAMPLES = 20;
/** Turns of the thread whose every turn left a Workspace Kit checkpoint. */
const CHECKPOINTED_TURNS = 60;

/**
 * One thread of `turns` user turns, each with a tool call, its result and an
 * answer. With `checkpointTree`, each turn also carries Workspace Kit's
 * checkpoint entry and its before/after refs on that tree.
 */
function writeThread(SessionManager, cwd, sessionDir, turns, provider, model, checkpointTree) {
  const manager = SessionManager.create(cwd, sessionDir);
  const sessionId = manager.getSessionId();
  const refs = [];
  const at = Date.now();
  const assistant = (content, index) => ({
    role: "assistant", content, api: "openai-completions", provider, model,
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: at + index,
  });
  for (let turn = 0; turn < turns; turn += 1) {
    const index = turn * 4;
    const callId = `call-${turn}`;
    const promptId = manager.appendMessage({ role: "user", content: [{ type: "text", text: `Question ${turn}: what does file ${turn} contain?` }], timestamp: at + index });
    manager.appendMessage(assistant([{ type: "toolCall", id: callId, name: "bash", arguments: { command: `cat file-${turn}.txt` } }], index + 1));
    manager.appendMessage({ role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text: `line ${turn}\n`.repeat(8) }], isError: false, timestamp: at + index + 2 });
    manager.appendMessage(assistant([{ type: "text", text: `File ${turn} holds eight lines that each name the turn.` }], index + 3));
    if (checkpointTree) {
      const turnId = `turn-${turn}`;
      const ref = (phase) => `refs/tau/checkpoints/${sessionId}/${turnId}/${phase}`;
      refs.push(ref("before"), ref("after"));
      manager.appendCustomEntry("tau.turn-checkpoint.v1", {
        id: turnId, turnId, sessionId, anchorMessageId: promptId, beforeSnapshotId: ref("before"), afterSnapshotId: ref("after"),
        startedAt: at + index, endedAt: at + index + 3, files: [], added: 1, removed: 1,
      });
    }
  }
  if (checkpointTree) execFileSync("git", ["-C", cwd, "update-ref", "--stdin"], { input: refs.map((ref) => `create ${ref} ${checkpointTree}\n`).join("") });
  return { path: manager.getSessionFile(), entries: manager.getEntries().length };
}

/**
 * Model and thinking-level changes in a short and a long thread. Its own agent
 * directory: a model change needs a provider with a key, and must not touch
 * the settings of whoever runs the benchmark.
 */
const BENCH_PROVIDER = "tau-bench";

/** An agent directory with one provider that never answers; no real settings are read or written. */
async function benchmarkAgentDir(name) {
  const agentDir = join(alternate, name);
  await mkdir(agentDir, { recursive: true });
  await writeTextFile(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      [BENCH_PROVIDER]: {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        apiKey: "benchmark",
        models: [{ id: "bench-a", reasoning: true }, { id: "bench-b", reasoning: true }],
      },
    },
  }));
  return agentDir;
}

async function measureMetadataCommands(PiHost, ProjectHistory, SessionManager) {
  const agentDir = await benchmarkAgentDir("metadata-agent");
  const sessionDir = join(alternate, "metadata-sessions");
  const provider = BENCH_PROVIDER;
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

/**
 * A thread of LONG_THREAD_TURNS turns with every shipped kit loaded: opened
 * from a short thread, and active when the host starts. Each sample is a host
 * of its own, so the thread is never live before it is measured. Everything a
 * kit might write goes under the benchmark's own directory.
 */
async function measureLargeThread(PiHost, ProjectHistory, SessionManager, kits, versions) {
  const agentDir = await benchmarkAgentDir("large-agent");
  const workspace = join(alternate, "large-workspace");
  const sessionDir = join(alternate, "large-sessions");
  execFileSync("git", ["init", "-b", "main", workspace], { stdio: "ignore" });
  const saved = {};
  const isolate = {
    HOME: join(alternate, "large-home"),
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    TAU_CONFIG_FILE: join(alternate, "large-config.json"),
    TAU_WORKTREES_DIR: join(alternate, "large-worktrees"),
    TAU_THEMES_DIR: join(alternate, "large-themes"),
    TAU_IMPORT_ROOTS: join(alternate, "large-import-roots"),
    CODEX_HOME: join(alternate, "large-codex"),
    TAU_NO_WATCH: "1",
    TAU_NO_PREWARM: "1",
    TAU_NO_RUNTIME_UPDATES: "1",
  };
  for (const [key, value] of Object.entries(isolate)) { saved[key] = process.env[key]; process.env[key] = value; }
  await mkdir(isolate.HOME, { recursive: true });
  const long = writeThread(SessionManager, workspace, sessionDir, LONG_THREAD_TURNS, BENCH_PROVIDER, "bench-a");
  execFileSync("git", ["-C", workspace, "-c", "user.name=Tau Benchmark", "-c", "user.email=tau@example.invalid", "commit", "-q", "--allow-empty", "-m", "fixture"], { stdio: "ignore" });
  const tree = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const checkpointed = writeThread(SessionManager, workspace, sessionDir, CHECKPOINTED_TURNS, BENCH_PROVIDER, "bench-a", tree);
  const short = writeThread(SessionManager, workspace, sessionDir, 2, BENCH_PROVIDER, "bench-a");
  const newest = `Question ${LONG_THREAD_TURNS - 1}:`;
  const firstPage = (detail, scenario) => {
    const messages = detail?.messages ?? [];
    if (!messages.some((message) => message.role === "user" && message.text?.startsWith(newest))) {
      throw new Error(`${scenario}: the first page lacks the newest turn`);
    }
    return messages.length;
  };
  // Pi starts in the workspace's most recently modified session.
  const makeActive = (path) => {
    const at = new Date();
    utimesSync(path, at, at);
  };
  const samples = [];
  const kitFailures = [];
  let pageMessages = 0;
  let hostIndex = 0;
  const withHost = async (work) => {
    const history = new ProjectHistory(join(alternate, `large-projects-${hostIndex}.json`));
    await history.load();
    const events = [];
    const host = new PiHost(workspace, (event) => {
      if (event.type === "event-log") events.push({ label: event.label, at: performance.now() });
    }, history, false, false, {
      hostExtensions: kits.shippedHostExtensions({ appPath: root, cacheDir: join(alternate, "large-host-extensions"), versions }, (label, detail) => {
        if (label === "host-extension.kit.failed") kitFailures.push(detail);
      }),
      kitStateDir: join(alternate, `large-kit-state-${hostIndex}`),
      turnsInFlightPath: join(alternate, `large-turns-${hostIndex}.json`),
      threadTrashDir: join(alternate, `large-trash-${hostIndex}`),
    });
    hostIndex += 1;
    try {
      await work(host, events);
      if (kitFailures.length > 0) throw new Error(`kits failed to load:\n${kitFailures.join("\n")}`);
    } finally {
      await host.dispose();
      await history.flush();
    }
  };
  try {
    for (let run = 0; run < HOST_RUNS; run += 1) {
      makeActive(short.path);
      await withHost(async (host) => {
        await host.start();
        const started = performance.now();
        const result = await host.switchSession(long.path);
        const durationMs = performance.now() - started;
        pageMessages = Math.max(pageMessages, firstPage(result.updates?.find((update) => update.type === "thread-detail")?.detail, "open"));
        samples.push({ scenario: "open", durationMs });
        // Workspace Kit checks a thread's checkpoints before it opens; that check must not grow with them.
        const checkpointedStarted = performance.now();
        await host.switchSession(checkpointed.path);
        samples.push({ scenario: "open-checkpointed", durationMs: performance.now() - checkpointedStarted });
      });
      makeActive(long.path);
      await withHost(async (host, events) => {
        const started = performance.now();
        const bootstrap = await host.start();
        samples.push({ scenario: "bootstrap", durationMs: performance.now() - started });
        pageMessages = Math.max(pageMessages, firstPage(bootstrap.detail, "bootstrap"));
        const deadline = Date.now() + 120_000;
        while (!events.some((event) => event.label === "bootstrap.full-ready") && Date.now() < deadline) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
        }
        const ready = events.find((event) => event.label === "bootstrap.full-ready");
        if (!ready) throw new Error("bootstrap: the host never reported full-ready");
        samples.push({ scenario: "full-ready", durationMs: ready.at - started });
      });
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return {
    entries: long.entries,
    pageMessages,
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
  const [{ PiHost }, { ProjectHistory }, { SessionManager, VERSION: PI_VERSION }, { compactHeap }, kits, { EXTENSION_API_VERSION }] = await Promise.all([
    import(pathToFileURL(join(root, "dist-electron", "main", "pi-host.js")).href),
    import(pathToFileURL(join(root, "dist-electron", "main", "project-history.js")).href),
    import("@earendil-works/pi-coding-agent"),
    import(pathToFileURL(join(root, "dist-electron", "main", "host-idle-compaction.js")).href),
    import(pathToFileURL(join(root, "dist-electron", "main", "bundled-kits.js")).href),
    import(pathToFileURL(join(root, "dist-electron", "shared", "extension-compat.js")).href),
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
  // Kits are Full Mode's; safe mode loads none.
  const tauVersion = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  const largeThread = mode === "full"
    ? await measureLargeThread(PiHost, ProjectHistory, SessionManager, kits, { tau: tauVersion, pi: PI_VERSION, api: EXTENSION_API_VERSION })
    : undefined;
  const report = {
    schemaVersion: 3,
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
    ...(largeThread ? { largeThread } : {}),
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
  // Kits may still flush a file while the last host stops.
  await rm(alternate, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
