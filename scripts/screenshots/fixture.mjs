// Sample data for the product screenshots: three projects with worktree
// branches in every review state, threads on the Agent SDK runtime, Codex and
// Pi, plan limits for the sidebar's juicebars and the stubs an isolated
// instance needs. Anthropic models run on the Agent SDK runtime only, never through Pi.
// Everything is written under `root`; nothing names a real person, path or host.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Where the fixture puts things; the runner's environment points the instance at the same paths. */
export function fixturePaths(root) {
  const home = join(root, "home");
  return {
    root,
    home,
    code: join(home, "code"),
    worktrees: join(home, "worktrees"),
    userData: join(root, "userdata"),
    sessions: join(root, "pi-sessions"),
    agentDir: join(home, ".pi", "agent"),
    codexHome: join(home, ".codex"),
    sdkHome: join(home, ".agent-sdk"),
    bin: join(root, "bin"),
    zdotdir: join(root, "zdotdir"),
    stubs: join(root, "stubs"),
    configFile: join(root, "tau-config.json"),
  };
}

function gitIn(cwd, args, at) {
  const date = new Date(at).toISOString();
  return execFileSync("git", ["-c", "user.name=Sample", "-c", "user.email=sample@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  }).trim();
}

function write(dir, rel, text) {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

const title = (name) => `${name[0].toUpperCase()}${name.slice(1)}`;
const ROUTES = ["orders", "products", "customers", "invoices", "shipments"];
const route = (name) => `import { db } from "../lib/db";\n\nexport async function list${title(name)}() {\n  return db.${name}.findMany({ orderBy: { id: "asc" } });\n}\n`;
const pagedRoute = (name) => `import { db } from "../lib/db";\nimport { decode, type Cursor } from "../lib/cursor";\nimport { page } from "../lib/envelope";\n\nexport async function list${title(name)}(cursor?: Cursor, limit = 50) {\n  const rows = await db.${name}.findMany({\n    where: cursor ? { id: { gt: decode(cursor) } } : undefined,\n    orderBy: { id: "asc" },\n    take: limit + 1,\n  });\n  return page(rows, limit);\n}\n`;
const ENVELOPE = "import { encode, type Cursor } from \"./cursor\";\n\nexport interface Page<T> {\n  items: T[];\n  next: Cursor | null;\n}\n";
/** What the stub CLI offers as the Agent SDK runtime's models; the first is the threads'. */
export const SDK_MODELS = [
  { value: "fable", displayName: "Fable", description: "Anthropic's newest model", resolvedModel: "claude-fable-5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh"] },
  { value: "opus", displayName: "Opus", description: "For complex work", resolvedModel: "claude-opus-5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh"] },
  { value: "sonnet", displayName: "Sonnet", description: "For everyday tasks", resolvedModel: "claude-sonnet-5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
  { value: "haiku", displayName: "Haiku", description: "Fastest for quick answers", resolvedModel: "claude-haiku-4-5" },
];
/** The Antigravity release Tau pins (`kits/antigravity/release.ts`), so the sample copy reads as current. */
const ANTIGRAVITY_VERSION = "agy_acp_server_1.1.1";
const WATCHER = "export function PairingRequestWatcher({ onRequest }) {\n  useEffect(() => {\n    return watcher.subscribe(onRequest);\n  }, []);\n}\n";

/**
 * Writes the fixture and returns its paths. `baseUrl` is the fake model's; every
 * provider the sample threads name points there, so no request can leave the machine.
 */
export function writeFixture({ root, baseUrl, tauRoot, now = Date.now() }) {
  const paths = fixturePaths(root);
  for (const dir of [paths.code, paths.worktrees, paths.userData, paths.sessions, paths.agentDir, paths.codexHome, paths.sdkHome, paths.bin, paths.zdotdir, paths.stubs]) {
    mkdirSync(dir, { recursive: true });
  }

  const repo = (name, files, history) => {
    const dir = join(paths.code, name);
    mkdirSync(dir, { recursive: true });
    gitIn(dir, ["init", "-q", "-b", "main"], now - 30 * DAY);
    let at = now - 30 * DAY;
    for (const [changes, message] of [[files, "Initial commit"], ...history]) {
      for (const [rel, text] of Object.entries(changes)) write(dir, rel, text);
      gitIn(dir, ["add", "-A"], at);
      gitIn(dir, ["commit", "-qm", message], at);
      at += 2 * DAY;
    }
    return realpathSync(dir);
  };
  const commit = (dir, files, message, at) => {
    for (const [rel, text] of Object.entries(files)) write(dir, rel, text);
    gitIn(dir, ["add", "-A"], at);
    gitIn(dir, ["commit", "-qm", message], at);
  };
  // The folder carries the repository's name, so a thread there shows its project, not the branch folder.
  const worktree = (dir, branch, work = []) => {
    const name = dir.split("/").at(-1);
    const path = join(paths.worktrees, branch.replaceAll("/", "-"), name);
    mkdirSync(join(path, ".."), { recursive: true });
    gitIn(dir, ["worktree", "add", "-q", "-b", branch, path, "main"], now);
    gitIn(dir, ["config", `branch.${branch}.tau-base`, "main"], now);
    for (const [files, message, at] of work) commit(path, files, message, at);
    return realpathSync(path);
  };

  const shop = repo("shop-api", {
    "package.json": `${JSON.stringify({ name: "shop-api", private: true, type: "module", scripts: { test: "vitest run", dev: "tsx watch src/server.ts" } }, null, 2)}\n`,
    "README.md": "# shop-api\n\nOrders, products and customers for the shop.\n",
    "favicon.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 32 32\"><rect width=\"32\" height=\"32\" rx=\"7\" fill=\"#e8743b\"/><path d=\"M9 12h14l-1.5 11h-11z\" fill=\"#fff\"/><path d=\"M12.5 12a3.5 3.5 0 0 1 7 0\" stroke=\"#fff\" stroke-width=\"2\" fill=\"none\"/></svg>\n",
    "src/server.ts": "import { app } from \"./app\";\n\napp.listen(3000);\n",
    "src/lib/db.ts": "export const db = {} as any;\n",
    "docs/adr/README.md": "# Decisions\n",
    ...Object.fromEntries(ROUTES.map((name) => [`src/routes/${name}.ts`, route(name)])),
  }, [
    [{ "src/routes/checkout.ts": "export async function checkout(customerId: string) {\n  return { ok: true };\n}\n" }, "Add checkout route"],
    [{ "src/lib/auth.ts": "export function requireCustomer() {}\n" }, "Require a signed-in customer"],
  ]);
  const desk = repo("desk-app", {
    "README.md": "# desk-app\n",
    "package.json": "{ \"name\": \"desk-app\", \"private\": true }\n",
    "src/renderer/pairing/PairingRequestWatcher.tsx": WATCHER,
    "src/renderer/pairing/watcher.ts": "export class Watcher {\n  subscribe() {}\n}\n",
    "src/renderer/diff/DiffViewer.tsx": "export function DiffViewer({ rows }) {\n  return rows.map((row) => <Row row={row} />);\n}\n",
  }, []);
  const garden = repo("garden-planner", {
    "README.md": "# garden-planner\n\nWhat to sow when, for a small allotment.\n",
    "package.json": "{ \"name\": \"garden-planner\", \"private\": true }\n",
    "src/calendar.ts": "export const months = [\"Jan\", \"Feb\", \"Mar\", \"Apr\", \"May\", \"Jun\", \"Jul\", \"Aug\", \"Sep\", \"Oct\", \"Nov\", \"Dec\"];\n",
    "src/weather.ts": "export async function forecast(lat: number, lon: number) {\n  return [];\n}\n",
  }, []);

  const at = { deps: now - 4 * DAY, calendar: now - 3 * DAY, adr: now - 2 * DAY, diff: now - DAY, handshake: now - 5 * HOUR, frost: now - 3 * HOUR, rate: now - 40 * MIN, flake: now - 18 * MIN, pagination: now - 6 * MIN };
  const flake = worktree(desk, "fix/pairing-flake", [[{
    "src/renderer/pairing/PairingRequestWatcher.tsx": WATCHER.replace("  useEffect(() => {\n    return watcher.subscribe(onRequest);\n  }, []);", "  // Subscribe before the first paint: the host may already hold a request.\n  const watcher = useMemo(() => new Watcher(onRequest), []);\n  useEffect(() => () => watcher.dispose(), [watcher]);"),
    "src/renderer/pairing/PairingRequestWatcher.test.tsx": "it('replays a request that came before the first paint', () => {});\n".repeat(3),
    "src/renderer/pairing/watcher.ts": "export class Watcher {\n  constructor(onRequest) { this.onRequest = onRequest; this.queue = []; }\n  replay() { for (const r of this.queue) this.onRequest(r); }\n  dispose() {}\n}\n",
  }, "Subscribe on construction and replay held requests", at.flake]]);
  const diffView = worktree(desk, "perf/diff-virtual", [
    [{ "src/renderer/diff/DiffViewer.tsx": "export function DiffViewer({ rows }) {\n  const visible = useVirtual(rows);\n  return visible.map((row) => <Row key={row.id} row={row} />);\n}\n" }, "Mount only the rows in view", at.diff],
    [{ "src/renderer/diff/useVirtual.ts": "export function useVirtual(rows) {\n  return rows.slice(0, 80);\n}\n" }, "Render a window of 80 rows", at.diff + 10 * MIN],
  ]);
  const rate = worktree(shop, "feat/rate-limit", [[{
    "src/lib/rate-limit.ts": "const buckets = new Map<string, { tokens: number; at: number }>();\n\nexport function take(key: string, perMinute = 30) {\n  const now = Date.now();\n  const bucket = buckets.get(key) ?? { tokens: perMinute, at: now };\n  bucket.tokens = Math.min(perMinute, bucket.tokens + ((now - bucket.at) / 60_000) * perMinute);\n  bucket.at = now;\n  if (bucket.tokens < 1) return false;\n  bucket.tokens -= 1;\n  buckets.set(key, bucket);\n  return true;\n}\n",
    "src/routes/checkout.ts": "import { take } from \"../lib/rate-limit\";\n\nexport async function checkout(customerId: string) {\n  if (!take(customerId)) return { ok: false, status: 429 };\n  return { ok: true };\n}\n",
  }, "Limit checkout to 30 requests a minute per customer", at.rate]]);
  const adr = worktree(shop, "docs/webhook-retries", [[{ "docs/adr/0007-webhook-retries.md": "# 7. Webhook retries\n\nRetry failed deliveries with exponential backoff, at most five times, then park them for a manual replay.\n" }, "ADR 7: webhook retries", at.adr]]);
  const pagination = worktree(shop, "feat/pagination", [[{ "src/lib/envelope.ts": ENVELOPE, "src/lib/cursor.ts": "export type Cursor = string & { readonly __brand: \"cursor\" };\n\nexport const encode = (id: number) => Buffer.from(String(id)).toString(\"base64url\") as Cursor;\n" }, "Add a page envelope and cursor helpers", at.pagination - 3 * MIN]]);
  // The thread's latest work is not committed yet, so Files has a Changed tree and a diff.
  write(pagination, "src/lib/envelope.ts", `${ENVELOPE}\n/** One more row than asked tells whether another page exists. */\nexport function page<T extends { id: number }>(rows: T[], limit: number): Page<T> {\n  const more = rows.length > limit;\n  const items = more ? rows.slice(0, limit) : rows;\n  return { items, next: more ? encode(items[items.length - 1].id) : null };\n}\n`);
  write(pagination, "src/lib/cursor.ts", "export type Cursor = string & { readonly __brand: \"cursor\" };\n\nexport const encode = (id: number) => Buffer.from(String(id)).toString(\"base64url\") as Cursor;\nexport const decode = (cursor: Cursor) => Number(Buffer.from(cursor, \"base64url\").toString());\n");
  for (const name of ROUTES) write(pagination, `src/routes/${name}.ts`, pagedRoute(name));
  const deps = worktree(shop, "chore/deps", [[{ "package.json": `${JSON.stringify({ name: "shop-api", private: true, type: "module", scripts: { test: "vitest run", dev: "tsx watch src/server.ts" }, devDependencies: { tsx: "^4.21.0", vitest: "^4.1.0" } }, null, 2)}\n` }, "Bump dev dependencies", at.deps]]);
  const frost = worktree(garden, "feat/frost-warning", [[{ "src/frost.ts": "import { forecast } from \"./weather\";\n\nexport async function frostNights(lat: number, lon: number) {\n  return (await forecast(lat, lon)).filter((night) => night.min <= 1);\n}\n", "src/calendar.ts": "export const months = [\"Jan\", \"Feb\", \"Mar\", \"Apr\", \"May\", \"Jun\", \"Jul\", \"Aug\", \"Sep\", \"Oct\", \"Nov\", \"Dec\"];\nexport const lastFrost = { month: 4, day: 15 };\n" }, "Warn about frost nights before planting out", at.frost]]);
  // main moves on: chore/deps is merged, and the diff viewer's branch now conflicts.
  gitIn(shop, ["merge", "-q", "--no-ff", "-m", "Merge branch 'chore/deps'", "chore/deps"], at.deps + HOUR);
  commit(desk, { "src/renderer/diff/DiffViewer.tsx": "export function DiffViewer({ rows }) {\n  return rows.map((row) => <Row key={row.path} row={row} />);\n}\n" }, "Key diff rows by path", at.diff + HOUR);

  // Anthropic models run on the Agent SDK runtime only; Pi uses other providers, Codex its own runtime.
  const usage = (costUsd, turns) => ({ inputTokens: 38_400 * turns, outputTokens: 4_100 * turns, cacheReadTokens: 210_000 * turns, cacheWriteTokens: 12_000 * turns, totalTokens: 264_500 * turns, costUsd, turns });
  const runtimeRecord = (cwd, name, turns, { start, cost }) => {
    let clock = start;
    const messages = turns.flatMap((turn) => [{ role: "user", text: turn.user, timestamp: (clock += 20_000) }, { role: "assistant", text: turn.reply, timestamp: (clock += 90_000) }]);
    return { tauThreadId: randomUUID(), cwd, messages, title: name, titleSource: "generated", usage: usage(cost, turns.length), updatedAt: clock };
  };
  const sdkThreads = [];
  const codexThreads = [];
  const sdk = (cwd, name, turns, options) => {
    sdkThreads.push({ backendKind: "claude-code", ...runtimeRecord(cwd, name, turns, options), claudeSessionId: randomUUID(), started: true, attempted: true, attemptCount: 1, createFallbackUsed: false, lastAttemptOutcome: "started", model: SDK_MODELS[0].value, observedModel: SDK_MODELS[0].value, effort: "high" });
  };
  const codex = (cwd, name, turns, options) => {
    codexThreads.push({ backendKind: "codex", ...runtimeRecord(cwd, name, turns, options), codexThreadId: randomUUID(), model: "gpt-5.6-sol", observedModel: "gpt-5.6-sol", effort: "medium" });
  };
  const gemini = { provider: "google", model: "gemini-3.8-flash" };
  const qwen = { provider: "opencode-go", model: "qwen3.8-max" };
  const thread = (cwd, name, turns, { provider, model, start, cost = 0.2 }) => {
    let clock = start;
    const id = randomUUID();
    const stamp = () => new Date(clock += 20_000).toISOString();
    const lines = [{ type: "session", version: 3, id, timestamp: stamp(), cwd }];
    let parent = null;
    const push = (entry) => { const entryId = randomUUID().slice(0, 8); lines.push({ id: entryId, parentId: parent, timestamp: stamp(), ...entry }); parent = entryId; };
    const tokens = (total) => ({ input: 1200, output: 140, cacheRead: 0, cacheWrite: 0, totalTokens: 1340, cost: { input: total / 2, output: total / 2, cacheRead: 0, cacheWrite: 0, total } });
    push({ type: "model_change", provider, modelId: model });
    for (const turn of turns) {
      push({ type: "message", message: { role: "user", content: [{ type: "text", text: turn.user }], timestamp: clock } });
      push({ type: "message", message: { role: "assistant", provider, model, content: [{ type: "text", text: turn.reply }], usage: tokens(cost / turns.length), stopReason: "stop", timestamp: clock } });
    }
    push({ type: "session_info", name });
    writeFileSync(join(paths.sessions, `${new Date(start).toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  };
  codex(deps, "Bump dev dependencies", [{ user: "Bump the dev dependencies and run the tests.", reply: "Bumped vitest and tsx. All 41 tests pass." }], { start: at.deps, cost: 0.12 });
  thread(garden, "Why does the calendar skip March?", [{ user: "The sowing calendar jumps from February to April. Why?", reply: "`months` is fine; the view hides months without sowing entries, and March has none in the sample data." }], { ...qwen, start: at.calendar, cost: 0.06 });
  thread(adr, "Write an ADR for webhook retries", [{ user: "Write an ADR for how we retry webhooks.", reply: "Wrote `docs/adr/0007-webhook-retries.md`: exponential backoff, at most five tries, then the delivery waits for a manual replay." }], { ...gemini, start: at.adr, cost: 0.2 });
  codex(diffView, "Virtualise the diff viewer", [{ user: "Large diffs freeze the window. Virtualise the diff viewer.", reply: "Rows now mount only inside the viewport, in a window of 80." }, { user: "Keep the keys stable.", reply: "Rows are keyed by id." }], { start: at.diff, cost: 0.4 });
  sdk(desk, "Explain the host handshake", [{ user: "How does the window find and trust the host?", reply: "The window sends `hello` with its token; the host answers with its version and the kits it runs." }], { start: at.handshake, cost: 0.05 });
  thread(frost, "Frost warning before planting out", [{ user: "Warn me when a frost night is forecast in the week I plan to plant out.", reply: "`frostNights()` reads the forecast and flags nights at or below 1 °C. The planner marks them on the planting week." }], { ...qwen, start: at.frost, cost: 0.31 });
  codex(rate, "Rate limit the checkout endpoint", [{ user: "Checkout gets hammered by retries. Add a rate limit per customer.", reply: "Added a token bucket per customer: 30 requests a minute, `429` above that." }], { start: at.rate, cost: 1.12 });
  sdk(flake, "Fix the flaky pairing test", [
    { user: "The pairing watcher test fails about one run in five. Find the race.", reply: "The watcher subscribed in an effect, after a request could already have arrived." },
    { user: "Fix it without widening the timeout.", reply: "The watcher subscribes on construction now and replays what the host holds. 20 repeated runs pass." },
  ], { start: at.flake, cost: 0.84 });
  sdk(pagination, "Add cursor pagination to list endpoints", [{
    user: "Every list endpoint should take `?cursor` and `?limit` and answer with the same envelope. Leave auth alone.",
    reply: "All five list routes now take `cursor` and `limit` (default 50) and return the same envelope:\n\n```ts\ninterface Page<T> {\n  items: T[];\n  next: Cursor | null;\n}\n```\n\n- `page()` in `src/lib/envelope.ts` asks for one row more than `limit`, so it knows whether another page exists without a `count(*)`.\n- The cursor is the last row's id, base64url-encoded. Clients treat it as opaque.\n- Auth is untouched.\n\nThe 24 route tests pass. The changes are not committed yet.",
  }], { start: at.pagination, cost: 1.86 });
  // The runtime kits keep their threads beside the Pi session store.
  mkdirSync(join(root, "tau"), { recursive: true });
  writeFileSync(join(root, "tau", "claude-runtime-sessions.json"), `${JSON.stringify({ version: 1, sessions: sdkThreads }, null, 2)}\n`);
  writeFileSync(join(root, "tau", "codex-runtime-sessions.json"), `${JSON.stringify({ version: 1, sessions: codexThreads }, null, 2)}\n`);

  // Review Kit's book: a note sent back to the ADR thread, and last week's merge with what it cost.
  const tip = (path) => gitIn(path, ["rev-parse", "HEAD"], now);
  const reviews = join(paths.userData, "kit-state", "tau.review");
  mkdirSync(reviews, { recursive: true });
  writeFileSync(join(reviews, "local-reviews.json"), `${JSON.stringify({
    version: 1,
    asks: { [`${shop}\ndocs/webhook-retries`]: { kind: "note", text: "Name the queue parked deliveries wait in, and who replays them.", at: now - 50 * MIN, tip: tip(adr) } },
    merged: [{ key: `${shop}\nchore/deps`, root: shop, branch: "chore/deps", target: "main", title: "Bump dev dependencies", project: "shop-api", at: at.deps + HOUR, files: 1, added: 4, removed: 0, costUsd: 0.12, modelProvider: "openai", model: "gpt-5.6-sol" }],
  }, null, 2)}\n`);

  // The Agent SDK runtime on a Max plan: the stub CLI's login and the windows its usage read reports.
  const kitState = join(paths.userData, "kit-state");
  writeFileSync(join(paths.sdkHome, "stub-login.json"), JSON.stringify({ authMethod: "claude.ai", email: "sample@example.invalid", orgName: "Sample", subscriptionType: "max" }));
  writeFileSync(join(paths.sdkHome, ".claude.json"), JSON.stringify({ oauthAccount: { organizationUuid: randomUUID(), accountUuid: randomUUID() } }));
  const sdkUsage = join(paths.stubs, "sdk-usage.json");
  const resets = (ms) => new Date(now + ms).toISOString();
  writeFileSync(sdkUsage, JSON.stringify({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 41, resets_at: resets(2 * HOUR + 10 * MIN) }, seven_day: { utilization: 58, resets_at: resets(3 * DAY + 5 * HOUR) } } }));
  // A test instance starts past the welcome wizard.
  mkdirSync(join(kitState, "tau.onboarding"), { recursive: true });
  writeFileSync(join(kitState, "tau.onboarding", "welcome.json"), `${JSON.stringify({ completedAt: new Date(now - 30 * DAY).toISOString() })}\n`);

  // Pi: the fake model, and the sample threads' providers routed to it with a dummy key.
  const routed = Object.fromEntries(["openai-codex", "google", "opencode-go"].map((provider) => [provider, { baseUrl, apiKey: "sample" }]));
  writeFileSync(join(paths.agentDir, "models.json"), `${JSON.stringify({ providers: routed }, null, 2)}\n`);
  writeFileSync(join(paths.agentDir, "settings.json"), `${JSON.stringify({ defaultProvider: "opencode-go", defaultModel: "qwen3.8-max" }, null, 2)}\n`);

  // Codex: the repo's stub app server, with plan limits whose resets lie ahead.
  const codexStub = join(paths.stubs, "codex");
  mkdirSync(codexStub, { recursive: true });
  for (const file of ["stub-app-server.mjs", "app-server-frames.json"]) copyFileSync(join(tauRoot, "kits", "codex", "fixtures", file), join(codexStub, file));
  const window = (used, minutes, resetsIn) => ({ usedPercent: used, windowDurationMins: minutes, resetsAt: Math.round((now + resetsIn) / 1000) });
  const limits = { limitId: "codex", limitName: null, normalModelSlug: null, primary: window(34, 300, 100 * MIN), secondary: window(47, 10080, 4 * DAY), credits: null, individualLimit: null, spendControlReached: null, planType: "pro", rateLimitReachedType: null };
  writeFileSync(join(codexStub, "rate-limits-read.json"), JSON.stringify({ ordinaryUsageAllowed: true, rateLimits: limits, rateLimitsByLimitId: { codex: limits } }, null, 2));
  const codexCommand = join(paths.bin, "codex");
  writeFileSync(codexCommand, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.156.1"; exit 0; fi\nif [ "$1" = "app-server" ]; then exec "${process.execPath}" "${join(codexStub, "stub-app-server.mjs")}" "$@"; fi\necho "stub codex: $*" >&2\nexit 1\n`);
  chmodSync(codexCommand, 0o755);

  // OpenCode: the repo's fake server, so the runtime reads as installed.
  const opencodeCommand = join(paths.bin, "opencode");
  writeFileSync(opencodeCommand, `#!/bin/sh\nexec "${process.execPath}" "${join(tauRoot, "kits", "opencode", "fixtures", "fake-serve.mjs")}" "$@"\n`);
  chmodSync(opencodeCommand, 0o755);
  // Antigravity: a "managed" copy of the pinned release whose server and harness only exist, and a
  // sign-in marker in Tau's own profile; nothing starts them.
  const antigravityRelease = "5".repeat(64);
  const antigravityManaged = join(kitState, "tau.antigravity", "tools", "antigravity-acp", `${process.platform}-${process.arch}`);
  const antigravity = join(antigravityManaged, "versions", antigravityRelease);
  mkdirSync(antigravity, { recursive: true });
  const stub = "#!/bin/sh\necho 'stub Antigravity: not a real server' >&2\nexit 1\n";
  for (const name of ["agy_acp_server.par", "localharness_external"]) {
    writeFileSync(join(antigravity, name), stub);
    chmodSync(join(antigravity, name), 0o755);
  }
  const file = (name) => ({ name, bytes: Buffer.byteLength(stub) });
  writeFileSync(join(antigravity, ".install-complete.json"), JSON.stringify({ releaseId: antigravityRelease, version: ANTIGRAVITY_VERSION, executable: file("agy_acp_server.par"), harness: file("localharness_external") }));
  writeFileSync(join(antigravityManaged, "active.json"), JSON.stringify({ releaseId: antigravityRelease }));
  const antigravityProfile = join(kitState, "tau.antigravity", "profile", "antigravity-acp");
  mkdirSync(antigravityProfile, { recursive: true });
  writeFileSync(join(antigravityProfile, "acp_token.json"), "{}\n");

  writeOutsideUsage(paths, { now, cwds: [shop, desk, garden] });

  // PATH: node for the stubs, a gh that is never logged in. The prompt shows only the folder.
  symlinkSync(process.execPath, join(paths.bin, "node"));
  writeFileSync(join(paths.bin, "gh"), "#!/bin/sh\necho 'not logged in' >&2\nexit 1\n");
  chmodSync(join(paths.bin, "gh"), 0o755);
  writeFileSync(join(paths.zdotdir, ".zshrc"), "PROMPT='%F{blue}%1~%f %# '\nRPROMPT=''\nPROMPT_EOL_MARK=''\nunsetopt PROMPT_SP\n");
  writeFileSync(paths.configFile, "{}\n");

  return { ...paths, codexCommand, sdkUsage, sdkModels: SDK_MODELS, projects: { shop, desk, garden }, worktreePaths: { pagination, rate, adr, flake, diffView, frost, deps } };
}

/** A fixed sequence in [0, 1), so every run draws the same history. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Six weeks of work outside Tau, in the CLIs' own log formats (counts only, no
 * conversation): Codex rollouts and the Agent SDK CLI's project logs. Usage
 * reads them the way it reads a real home's.
 */
export function writeOutsideUsage(paths, { now, cwds, days = 42 }) {
  const random = seeded(115);
  const iso = (at) => new Date(at).toISOString();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  let serial = 0;
  for (let back = days; back >= 1; back -= 1) {
    const day = today.getTime() - back * DAY;
    const weekday = new Date(day).getDay();
    // Quieter weekends, and a few days off.
    if ((weekday === 0 || weekday === 6) ? random() < 0.6 : random() < 0.12) continue;
    const busy = 0.5 + random() * 1.5;
    const cwd = cwds[Math.floor(random() * cwds.length)];
    const start = day + (9 + Math.floor(random() * 4)) * HOUR;
    const codexResponses = Math.round(6 + random() * 14 * busy);
    const sdkResponses = Math.round(5 + random() * 16 * busy);

    const id = `0199${String(serial += 1).padStart(4, "0")}-0000-7000-8000-${String(back).padStart(12, "0")}`;
    const stamp = new Date(day);
    const folder = join(paths.codexHome, "sessions", String(stamp.getFullYear()), String(stamp.getMonth() + 1).padStart(2, "0"), String(stamp.getDate()).padStart(2, "0"));
    const codex = [
      { timestamp: iso(start), type: "session_meta", payload: { id, cwd } },
      { timestamp: iso(start), type: "turn_context", payload: { model: random() < 0.7 ? "gpt-5.6-sol" : "gpt-5.6-luna" } },
    ];
    for (let index = 0; index < codexResponses; index += 1) {
      const input = Math.round(18_000 + random() * 60_000);
      const cached = Math.round(input * (0.6 + random() * 0.3));
      const output = Math.round(800 + random() * 4_000);
      codex.push({ timestamp: iso(start + index * 4 * MIN), type: "token_usage_record", payload: { response_id: `resp_${id}_${index}`, usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: input + output } } });
    }
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `rollout-${iso(start).slice(0, 19).replace(/:/g, "-")}-${id}.jsonl`), `${codex.map((line) => JSON.stringify(line)).join("\n")}\n`);

    const session = randomUUID();
    const project = join(paths.sdkHome, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    const sdkStart = start + 3 * HOUR;
    const sdkModel = random() < 0.65 ? "claude-fable-5" : "claude-sonnet-5";
    const sdk = [];
    for (let index = 0; index < sdkResponses; index += 1) {
      sdk.push({ type: "assistant", timestamp: iso(sdkStart + index * 3 * MIN), sessionId: session, cwd, requestId: `req_${session}_${index}`, message: { id: `msg_${session}_${index}`, role: "assistant", model: sdkModel, usage: { input_tokens: Math.round(200 + random() * 3_000), output_tokens: Math.round(600 + random() * 3_500), cache_read_input_tokens: Math.round(30_000 + random() * 90_000), cache_creation_input_tokens: Math.round(2_000 + random() * 12_000) } } });
    }
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${session}.jsonl`), `${sdk.map((line) => JSON.stringify(line)).join("\n")}\n`);
  }
}
