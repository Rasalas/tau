// Remote work end to end on this machine (plan-H, ADR 0027): host A and "rex"
// are two headless test hosts on 127.0.0.1 (tau-test-host.mjs), the project is
// a fixture repo with a local bare origin (remote-work-fixture.mjs), and the
// runtime is Pi on a fake model (fake-model-server.mjs). No real machine, no
// real remote, no login.
//
// STEPS run in order over one context. A step whose seam has not landed yet is
// `pending` and names its ticket; the run stays green and lists it. A ticket
// replaces its pending entries with real steps. Teardown stops only the pids
// this run started and then checks that none of their ports still listens.
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { FAKE_MODEL, FAKE_PROVIDER, prepareFakePiAgentDir, startFakeModelServer } from "./fake-model-server.mjs";
import { createRemoteWorkFixture } from "./remote-work-fixture.mjs";
import { startTestHost, stopTestHost } from "./tau-test-host.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist-electron");
if (!existsSync(join(DIST, "main", "headless.js")) || !existsSync(join(ROOT, "dist-web", "index.html"))) {
  console.error("✗ build first: npm run build");
  process.exit(1);
}
const { HostUplink } = await import(pathToFileURL(join(DIST, "main", "host-uplink.js")).href);
const { pinnedTlsConnect } = await import(pathToFileURL(join(DIST, "main", "host-tls-trust.js")).href);
const { pairWithHost } = await import(pathToFileURL(join(DIST, "shared", "host-pairing.js")).href);

// Host names in .tau-dev of their own, so a developer's `rex` test host is never touched.
const A = { name: "smoke-a", machineName: "mini" };
const REX = { name: "smoke-rex", machineName: "rex" };
const GUARD_MS = 240_000;
// A test-only package on rex that exposes sessions.import/send as commands; H06's kit replaces it.
const IMPORT_PROBE = "test.session-import-probe";
// A test-only package on both hosts that sends a file with services.machines.upload and takes it with services.blobs; H05's kit replaces it.
const BLOB_PROBE = "test.blob-probe";
// Remote Work Kit, on both hosts: it sends the fixture's state to rex and brings the result back.
const REMOTE_WORK = "tau.remote-work";
const installBlobProbe = (env) => cpSync(join(ROOT, "scripts", "fixtures", "blob-probe"), join(env.HOME, ".tau", "extensions", "blob-probe"), { recursive: true });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await wait(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** An owner connection over the host's loopback listener and token, as a window's process has one. */
function ownerUplink(host) {
  const pushes = [];
  const uplink = new HostUplink({
    url: host.url,
    token: readFileSync(host.tokenFile, "utf8").trim(),
    ...(host.publicKey ? { trust: { pin: { publicKey: host.publicKey } } } : {}),
    onPush: (push) => pushes.push(push),
  });
  return Object.assign(uplink, { pushes });
}

function pinnedSocket(host) {
  return (url) => new WebSocket(url, host.publicKey ? { createConnection: pinnedTlsConnect({ publicKey: host.publicKey }) } : {});
}

/** Git in a checkout, without the caller's hooks. */
const gitIn = (cwd, ...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** A git repo with one commit, for a host's own workspace. */
function initWorkspace(dir) {
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# rex's own workspace\n");
  git("add", "README.md");
  git("-c", "user.name=Tau Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-q", "-m", "chore: start");
}

/** Session files under a host's sessions folder, with their parsed entries. */
function sessionFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true })
    .filter((file) => String(file).endsWith(".jsonl"))
    .map((file) => {
      const path = join(dir, String(file));
      const text = readFileSync(path, "utf8");
      return { path, text, entries: text.trim().split("\n").map((line) => JSON.parse(line)) };
    });
}

const assistantTexts = (entries) => entries
  .filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
  .map((entry) => (entry.message.content ?? []).map((part) => part.text ?? "").join(""));

/**
 * The steps. `run(ctx)` returns a detail line or throws; `pending: "<ticket>"`
 * marks what a later ticket fills in.
 */
export const STEPS = [
  {
    title: "a fake model answers on 127.0.0.1",
    async run(ctx) {
      ctx.model = await startFakeModelServer();
      return ctx.model.baseUrl;
    },
  },
  {
    title: "fixture repo with a local bare origin and an uncommitted change",
    async run(ctx) {
      ctx.fixture = createRemoteWorkFixture({ name: "smoke", fresh: true });
      return `${ctx.fixture.work} ← ${ctx.fixture.originUrl}`;
    },
  },
  {
    title: "host A and rex start on loopback with kits and the fake model",
    async run(ctx) {
      const fakePi = (env) => prepareFakePiAgentDir(env.PI_CODING_AGENT_DIR, ctx.model.baseUrl);
      const [a, rex] = await Promise.all([
        startTestHost({ name: A.name, kits: true, fresh: true, login: false, workspace: ctx.fixture.work }, {
          machineName: A.machineName,
          prepare: (env) => { fakePi(env); installBlobProbe(env); },
        }),
        startTestHost({ name: REX.name, kits: true, tls: true, fresh: true, login: false }, {
          machineName: REX.machineName,
          prepare: (env) => {
            fakePi(env);
            initWorkspace(env.TAU_WORKSPACE);
            installBlobProbe(env);
            cpSync(join(ROOT, "scripts", "fixtures", "session-import-probe"), join(env.HOME, ".tau", "extensions", "session-import-probe"), { recursive: true });
          },
        }),
      ]);
      ctx.a = a;
      ctx.rex = rex;
      ctx.started.push(A.name, REX.name);
      ctx.aOwner = ownerUplink(a);
      ctx.rexOwner = ownerUplink(rex);
      const [aHello, rexHello] = await Promise.all([ctx.aOwner.hello(), ctx.rexOwner.hello()]);
      if (aHello.host?.name !== A.machineName || rexHello.host?.name !== REX.machineName) throw new Error(`the hosts call themselves ${aHello.host?.name} and ${rexHello.host?.name}`);
      if (aHello.host.id === rexHello.host.id) throw new Error("both hosts have the same host id");
      ctx.rexHostId = rexHello.host.id;
      return `A ${a.url} (pid ${a.pid}), rex ${rex.url} (pid ${rex.pid})`;
    },
  },
  {
    title: "A clones the fixture's origin over file:// (test clone root only) and refuses one outside it",
    async run(ctx) {
      const parent = join(dirname(ctx.a.userData), "clones");
      mkdirSync(parent, { recursive: true });
      const outside = await ctx.aOwner.request("host-extension", ["tau.workspace", "clone-start", { repositoryUrl: pathToFileURL(ROOT).href, parentPath: parent }])
        .then(() => "started", (error) => String(error.message));
      if (!/HTTPS or SSH/u.test(outside)) throw new Error(`a file:// clone outside .tau-dev/remote-work was not refused: ${outside}`);
      const job = await ctx.aOwner.request("host-extension", ["tau.workspace", "clone-start", { repositoryUrl: ctx.fixture.originUrl, parentPath: parent }]);
      let snapshot = job;
      await waitFor(async () => {
        const jobs = await ctx.aOwner.request("host-extension", ["tau.workspace", "clone-jobs"]);
        snapshot = jobs.find((entry) => entry.id === job.id) ?? snapshot;
        return snapshot.phase !== "running";
      }, "the clone on A");
      if (snapshot.phase !== "done") throw new Error(`the clone ended ${JSON.stringify(snapshot)}`);
      const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: snapshot.destination, encoding: "utf8" }).trim();
      if (head !== ctx.fixture.head) throw new Error(`the clone is at ${head}, origin at ${ctx.fixture.head}`);
      return snapshot.destination;
    },
  },
  {
    title: "rex runs a turn on the fake model that writes a file",
    async run(ctx) {
      await ctx.rexOwner.request("new-session", ["write fake-turn.txt ok"]);
      const target = join(ctx.rex.workspace, "fake-turn.txt");
      await waitFor(() => existsSync(target) && readFileSync(target, "utf8") === "ok\n", "the fake turn's file on rex");
      await waitFor(() => ctx.rexOwner.pushes.some((push) => push.event?.type === "agent-status" && push.event.running === false), "the turn to end on rex");
      const sessions = readdirSync(ctx.rex.sessionsDir, { recursive: true }).filter((file) => String(file).endsWith(".jsonl"));
      const transcript = sessions.map((file) => readFileSync(join(ctx.rex.sessionsDir, String(file)), "utf8")).join("\n");
      if (!transcript.includes(`"${FAKE_MODEL}"`) || !transcript.includes(`"${FAKE_PROVIDER}"`)) throw new Error("the session on rex does not name the fake model");
      return `${ctx.model.requests.length} model request(s), ${sessions.length} session file(s) on rex`;
    },
  },
  {
    // The smoke is A's window process here: it pairs for itself and A's agents, and hands their key to A's host (ADR 0027).
    title: "A pairs with rex for itself and its agents; rex's owner allows both at once over its loopback host token",
    async run(ctx) {
      let asked;
      const result = await pairWithHost({
        url: ctx.rex.url,
        name: A.machineName,
        publicKey: ctx.rex.publicKey,
        companion: { name: `${A.machineName} · Agents` },
        createSocket: pinnedSocket(ctx.rex),
        onWaiting: ({ verification }) => {
          asked = (async () => {
            const { requests } = await ctx.rexOwner.request("connections-list");
            const request = requests.find((entry) => entry.verification === verification);
            if (!request) throw new Error(`rex shows no request with the digits ${verification}`);
            await ctx.rexOwner.request("connections-approve", [request.id, {}]);
          })();
        },
      });
      await asked;
      if (result.state !== "approved") throw new Error(`pairing ended ${JSON.stringify(result)}`);
      ctx.pairing = result;
      const { clients } = await ctx.rexOwner.request("connections-list");
      const devices = clients.filter((client) => client.label?.startsWith(A.machineName));
      if (!devices.some((client) => client.id === result.clientId && client.access === "full")) throw new Error(`rex does not list A as a full device: ${JSON.stringify(clients)}`);
      if (!result.companion) throw new Error("rex answered no token for A's agents");
      const agents = devices.find((client) => client.id === result.companion.clientId);
      if (devices.length !== 2 || agents?.companionOf !== result.clientId) throw new Error(`rex does not list A and A's agents apart: ${JSON.stringify(devices)}`);
      return `two devices: ${devices.map((client) => client.label).join(", ")}`;
    },
  },
  {
    title: "A's paired device reaches rex over pinned TLS and runs a kit command there",
    async run(ctx) {
      const device = new HostUplink({ url: ctx.rex.url, token: ctx.pairing.token, trust: { pin: { publicKey: ctx.rex.publicKey } } });
      ctx.closers.push(() => device.close());
      const hello = await device.hello();
      if (hello.host?.name !== REX.machineName) throw new Error(`the paired device reached ${hello.host?.name}`);
      const stat = await device.request("host-extension", ["tau.files", "stat", { path: "README.md" }]);
      if (!stat || typeof stat !== "object") throw new Error(`tau.files/stat answered ${JSON.stringify(stat)}`);
      const refused = await device.request("connections-list").then(() => "answered", (error) => String(error.message));
      if (!/forbidden|owner|host token/iu.test(refused)) throw new Error(`a paired device managed rex's connections: ${refused}`);
      return "tau.files/stat README.md answered; connections-list refused";
    },
  },
  {
    title: "A's host keeps rex in host-machines.json and calls it through services.machines",
    async run(ctx) {
      const page = ctx.rex.url.replace(/^ws/u, "http");
      await ctx.aOwner.request("machines-add", [{
        id: ctx.rexHostId, name: REX.machineName, endpoints: [{ url: page, kind: "loopback" }], publicKey: ctx.rex.publicKey, token: ctx.pairing.companion.token,
      }]);
      const file = join(ctx.a.userData, "host-machines.json");
      const mode = statSync(file).mode & 0o777;
      if (mode !== 0o600) throw new Error(`host-machines.json has mode ${mode.toString(8)}`);
      await waitFor(async () => (await ctx.aOwner.request("machines-list")).machines.some((machine) => machine.id === ctx.rexHostId && machine.status === "connected"), "A's host to reach rex");
      // Machines Kit on A calls the same kit on rex through services.machines; rex names the device it came as.
      const probe = await ctx.aOwner.request("host-extension", ["tau.environments", "probe", { machine: REX.machineName }]);
      if (probe.device !== ctx.pairing.companion.clientId) throw new Error(`rex saw ${JSON.stringify(probe)}, not A's agents device`);
      return `probe as A's agents device in ${probe.ms} ms`;
    },
  },
  {
    title: "A's host sends rex a file in pieces through services.machines.upload; a kit on rex takes it once, and a Read-only device is refused",
    async run(ctx) {
      for (const owner of [ctx.aOwner, ctx.rexOwner]) {
        await owner.request("extension-grant", [BLOB_PROBE, true]);
        await waitFor(async () => (await owner.request("host-extensions")).some((entry) => entry.id === BLOB_PROBE && entry.active), "the blob probe");
      }
      const bytes = randomBytes(20 * 1024 * 1024);
      const file = join(dirname(ctx.a.userData), "random-20mb.bin");
      writeFileSync(file, bytes);
      const sum = createHash("sha256").update(bytes).digest("hex");
      const blobs = join(ctx.rex.userData, "blobs");
      const result = await ctx.aOwner.request("host-extension", [BLOB_PROBE, "send", { machine: REX.machineName, path: file }]);
      if (result.sent.sha256 !== sum || result.taken.sha256 !== sum || result.taken.size !== bytes.length) throw new Error(`the sums differ: ${JSON.stringify(result)}`);
      if (result.taken.device !== ctx.pairing.companion.clientId) throw new Error(`rex took the file as from ${result.taken.device}, not A's agents`);
      if (!/taken already/u.test(result.again)) throw new Error(`a second take answered ${result.again}`);
      if (result.progress.length !== 3 || result.progress.at(-1) !== bytes.length) throw new Error(`progress was ${JSON.stringify(result.progress)}`);
      if (existsSync(result.taken.path) || readdirSync(blobs).length > 0) throw new Error(`rex kept ${readdirSync(blobs).join(", ")}`);

      await ctx.rexOwner.request("connections-update-client", [ctx.pairing.companion.clientId, { access: "read-only" }]);
      const refused = await ctx.aOwner.request("host-extension", [BLOB_PROBE, "send", { machine: REX.machineName, path: file }]).then(() => "sent", (error) => String(error.message));
      await ctx.rexOwner.request("connections-update-client", [ctx.pairing.companion.clientId, { access: "full" }]);
      if (!/Read only; sending a file there needs Full access/u.test(refused)) throw new Error(`a Read-only device's upload ended: ${refused}`);
      if (readdirSync(blobs).length > 0) throw new Error(`rex kept ${readdirSync(blobs).join(", ")} of a refused upload`);
      return `20 MB in ${result.ms} ms, sha256 ${sum.slice(0, 12)}… on both sides; gone after take; Read only refused`;
    },
  },
  {
    title: "the fixture's state (commits + uncommitted change) reaches a mirror and worktree on rex as a bundle",
    async run(ctx) {
      const cwd = ctx.fixture.work;
      const offered = await ctx.aOwner.request("host-extension", [REMOTE_WORK, "ignored-files", { cwd }]);
      const paths = offered.candidates.map((candidate) => candidate.path);
      if (paths.join(",") !== ".env,.scratch/" || !offered.skipped.some((entry) => entry.path === "node_modules/" && entry.why === "build")) throw new Error(`A offers ${JSON.stringify(offered)}`);
      await ctx.aOwner.request("host-extension", [REMOTE_WORK, "set-ignored-files", { cwd, paths: [".env", ".scratch/"] }]);
      const remembered = await ctx.aOwner.request("host-extension", [REMOTE_WORK, "ignored-files", { cwd }]);
      if (remembered.selected.join(",") !== ".env,.scratch/") throw new Error(`A remembers ${JSON.stringify(remembered.selected)}`);
      const statusBefore = gitIn(cwd, "status", "--porcelain");

      const transfer = await ctx.aOwner.request("host-extension", [REMOTE_WORK, "send", { machine: REX.machineName, cwd, name: "smoke" }]);
      if (transfer.state !== "ready") throw new Error(`the transfer ended ${JSON.stringify(transfer)}`);
      const step = (id) => transfer.steps.find((entry) => entry.id === id);
      if (step("mirror")?.detail !== "Cloned from origin" || !/^1 commit, /u.test(step("bundle")?.detail ?? "")) throw new Error(`rex did not clone origin, or the bundle carried more than the state: ${JSON.stringify(transfer.steps)}`);
      const there = transfer.remote.path;
      const root = join(ctx.rex.home, ".tau", "remote-work");
      if (!there.startsWith(join(root, "worktrees") + "/") || !existsSync(join(root, "repos", `${transfer.repo.key}.git`, "HEAD"))) throw new Error(`the worktree is at ${there}, the mirror not under ${root}`);
      if (!readFileSync(join(there, "README.md"), "utf8").includes("An uncommitted line.") || !existsSync(join(there, "notes", "draft.md"))) throw new Error("the worktree on rex lacks A's uncommitted work");
      if (readFileSync(join(there, ".env"), "utf8") !== "FIXTURE_SECRET=not-a-secret\n" || !existsSync(join(there, ".scratch", "issues", "01-fixture.md")) || existsSync(join(there, "node_modules"))) throw new Error("the ignored files on rex are not the ones ticked");
      if (gitIn(there, "rev-parse", "HEAD") !== transfer.base || gitIn(there, "status", "--porcelain") !== "") throw new Error("the worktree on rex is not exactly the state that went");
      if (gitIn(cwd, "status", "--porcelain") !== statusBefore || gitIn(cwd, "branch", "--list") !== "* main") throw new Error("sending changed A's checkout");
      ctx.transfers = [transfer];
      return `${transfer.id} → rex:${there.slice(root.length + 1)} (${step("bundle").detail}, ignored ${step("files").detail})`;
    },
  },
  {
    title: "a Pi session from A is imported on rex with rex's cwd and its origin, and continues there",
    async run(ctx) {
      const aHost = (await ctx.aOwner.hello()).host;
      const known = new Set(sessionFiles(ctx.a.sessionsDir).map((file) => file.path));
      await ctx.aOwner.request("new-session", ["say one word"]);
      let source;
      await waitFor(() => {
        source = sessionFiles(ctx.a.sessionsDir).find((file) => !known.has(file.path) && assistantTexts(file.entries).includes("ok"));
        return Boolean(source);
      }, "the turn's answer in A's session file");

      await ctx.rexOwner.request("extension-grant", [IMPORT_PROBE, true]);
      await waitFor(async () => (await ctx.rexOwner.request("host-extensions")).some((entry) => entry.id === IMPORT_PROBE && entry.active), "the import probe on rex");
      const origin = { hostId: aHost.id, threadId: source.entries[0].id };
      const oldFormat = source.text.replace('"version":3', '"version":2');
      const refused = await ctx.rexOwner.request("host-extension", [IMPORT_PROBE, "import", { cwd: ctx.rex.workspace, jsonl: oldFormat, origin }])
        .then(() => "imported", (error) => String(error.message));
      if (!/session format 2/u.test(refused)) throw new Error(`rex took a session of format 2: ${refused}`);

      const imported = await ctx.rexOwner.request("host-extension", [IMPORT_PROBE, "import", { cwd: ctx.rex.workspace, jsonl: source.text, title: "From A", origin }]);
      await ctx.rexOwner.request("host-extension", [IMPORT_PROBE, "send", { sessionId: imported.sessionId, text: "say one more word" }]);
      let target;
      await waitFor(() => {
        target = sessionFiles(ctx.rex.sessionsDir).find((file) => file.path === imported.path);
        return Boolean(target) && assistantTexts(target.entries).length >= 2;
      }, "the continued turn on rex");
      const [header, first] = target.entries;
      if (header.id !== imported.sessionId || header.cwd !== ctx.rex.workspace || header.id === origin.threadId) throw new Error(`the header on rex is ${JSON.stringify(header)}`);
      if (first.customType !== "tau.remote-work/origin" || first.data?.hostId !== aHost.id || first.data?.threadId !== origin.threadId) throw new Error(`the entry after the header is ${JSON.stringify(first)}`);
      if (!target.text.includes("say one word") || !target.text.includes("say one more word")) throw new Error("the session on rex lacks the old history or the new prompt");
      const { threadIndex } = await ctx.rexOwner.request("bootstrap");
      const shell = threadIndex.sessions.find((session) => session.id === imported.sessionId);
      if (shell?.origin?.hostId !== aHost.id || shell.projectPath !== ctx.rex.workspace) throw new Error(`rex's index shows ${JSON.stringify(shell)}`);
      return `${imported.sessionId.slice(0, 8)} on rex: ${target.entries.length} entries, ${assistantTexts(target.entries).length} answers, origin ${aHost.id.slice(0, 8)}`;
    },
  },
  { title: "A starts a thread on rex with the fake model and follows its status to idle, with a cost", pending: "H06" },
  {
    title: "the result comes back as tau/rex/<slug> on A, merge-tree is clean, merge --no-ff lands it",
    async run(ctx) {
      const [transfer] = ctx.transfers;
      const there = transfer.remote.path;
      // rex's work, as a thread there would leave it (H06 starts one): one file changed, one new, nothing committed.
      writeFileSync(join(there, "src", "app.js"), "export const greeting = \"hello from rex\";\nexport const farewell = \"bye\";\n");
      writeFileSync(join(there, "CHANGELOG.md"), "- rex says hello\n");
      const back = await ctx.aOwner.request("host-extension", [REMOTE_WORK, "fetch-result", { transfer: transfer.id }]);
      if (back.result?.state !== "branch" || back.result.branch !== "tau/rex/smoke") throw new Error(`the result came back as ${JSON.stringify(back.result)}`);
      const cwd = ctx.fixture.work;
      if (gitIn(cwd, "config", "branch.tau/rex/smoke.tau-base") !== transfer.base) throw new Error("tau/rex/smoke does not record the state it started from");
      const preview = await ctx.aOwner.request("host-extension", [REMOTE_WORK, "preview", { transfer: transfer.id }]);
      if (!preview.clean) throw new Error(`merge-tree sees conflicts: ${preview.conflicts.join(", ")}`);
      const applied = await ctx.aOwner.request("host-extension", [REMOTE_WORK, "apply", { transfer: transfer.id }]);
      if (applied.applied?.state !== "merged") throw new Error(`apply answered ${JSON.stringify(applied.applied)}`);
      const parents = gitIn(cwd, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length - 1;
      if (parents !== 2 || gitIn(cwd, "status", "--porcelain") !== "") throw new Error(`A's checkout after the merge: ${parents} parents, status ${gitIn(cwd, "status", "--porcelain")}`);
      if (!readFileSync(join(cwd, "src", "app.js"), "utf8").includes("hello from rex") || !existsSync(join(cwd, "CHANGELOG.md"))) throw new Error("rex's work is not in A's checkout");
      return `${back.result.branch}: ${back.result.commits} commit, ${back.result.files} files; merged as ${applied.applied.commit.slice(0, 8)}, A's status clean`;
    },
  },
  {
    title: "a conflicting second run leaves A's checkout untouched",
    async run(ctx) {
      const cwd = ctx.fixture.work;
      const transfer = await ctx.aOwner.request("host-extension", [REMOTE_WORK, "send", { machine: REX.machineName, cwd, name: "smoke" }]);
      if (transfer.state !== "ready") throw new Error(`the second transfer ended ${JSON.stringify(transfer)}`);
      writeFileSync(join(transfer.remote.path, "src", "app.js"), "export const greeting = \"rex again\";\nexport const farewell = \"bye\";\n");
      writeFileSync(join(cwd, "src", "app.js"), "export const greeting = \"mini meanwhile\";\nexport const farewell = \"bye\";\n");
      gitIn(cwd, "-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qam", "change the greeting on A");
      const head = gitIn(cwd, "rev-parse", "HEAD");
      const back = await ctx.aOwner.request("host-extension", [REMOTE_WORK, "fetch-result", { transfer: transfer.id }]);
      if (back.result?.branch !== "tau/rex/smoke-2") throw new Error(`the second result came back as ${JSON.stringify(back.result)}`);
      const applied = await ctx.aOwner.request("host-extension", [REMOTE_WORK, "apply", { transfer: transfer.id }]);
      if (applied.applied?.state !== "conflict" || applied.applied.files.join(",") !== "src/app.js") throw new Error(`apply answered ${JSON.stringify(applied.applied)}`);
      if (gitIn(cwd, "rev-parse", "HEAD") !== head || gitIn(cwd, "status", "--porcelain") !== "") throw new Error("the conflict changed A's checkout");
      if (!readFileSync(join(cwd, "src", "app.js"), "utf8").includes("mini meanwhile")) throw new Error("A's file changed");
      const gone = await ctx.aOwner.request("host-extension", [REMOTE_WORK, "discard", { transfer: transfer.id }]);
      if (gone.state !== "discarded" || existsSync(transfer.remote.path)) throw new Error("the second worktree on rex is still there after discard");
      if (!gitIn(cwd, "rev-parse", "--verify", "tau/rex/smoke-2")) throw new Error("the conflicting branch is gone");
      return `conflict in ${applied.applied.files.join(", ")}; HEAD ${head.slice(0, 8)} and status unchanged; tau/rex/smoke-2 kept, rex's worktree removed`;
    },
  },
  // Last: it cuts A's agents off from rex.
  {
    title: "A's agents device revoked on rex → refused, A's own device still in",
    async run(ctx) {
      await ctx.rexOwner.request("connections-revoke-client", [ctx.pairing.companion.clientId]);
      await waitFor(async () => (await ctx.aOwner.request("machines-list")).machines.some((machine) => machine.id === ctx.rexHostId && machine.status === "refused"), "A's host to see rex refuse its agents");
      const refused = await ctx.aOwner.request("host-extension", ["tau.environments", "probe", { machine: REX.machineName }]).then(() => "answered", (error) => String(error.message));
      if (!/refuses this computer's agents/u.test(refused)) throw new Error(`a call after the revocation ended: ${refused}`);
      const device = new HostUplink({ url: ctx.rex.url, token: ctx.pairing.token, trust: { pin: { publicKey: ctx.rex.publicKey } } });
      ctx.closers.push(() => device.close());
      await device.hello();
      return refused;
    },
  },
];

/** Stops what this run started, by the pids in the hosts' own state files, then checks nothing listens. */
async function teardown(ctx) {
  for (const close of ctx.closers.splice(0)) {
    try { close(); } catch { /* already closed */ }
  }
  ctx.aOwner?.close();
  ctx.rexOwner?.close();
  const ports = [ctx.a?.url, ctx.rex?.url].filter(Boolean).map((url) => Number(new URL(url).port));
  const pids = [ctx.a?.pid, ctx.rex?.pid].filter(Boolean);
  for (const name of [A.name, REX.name]) await stopTestHost(name);
  if (ctx.model) {
    ports.push(ctx.model.port);
    await ctx.model.close();
  }
  const alive = pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  const listening = [];
  for (const port of ports) {
    const open = await new Promise((resolve) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (open) listening.push(port);
  }
  return { alive, listening, ports };
}

async function main() {
  const guard = setTimeout(() => {
    console.error(`✗ the smoke ran into its ${GUARD_MS / 1000}s guard`);
    process.exit(1);
  }, GUARD_MS);
  guard.unref();
  // A run that crashed earlier may have left its hosts; stop them by their recorded pids first.
  for (const name of [A.name, REX.name]) await stopTestHost(name);
  const ctx = { started: [], closers: [] };
  const pending = [];
  let failed = false;
  for (const step of STEPS) {
    if (step.pending) {
      pending.push(step);
      console.log(`○ ${step.title} — pending (${step.pending})`);
      continue;
    }
    try {
      const detail = await step.run(ctx);
      console.log(`✓ ${step.title}${detail ? ` — ${detail}` : ""}`);
    } catch (error) {
      console.error(`✗ ${step.title}: ${error instanceof Error ? error.message : String(error)}`);
      for (const host of [ctx.a, ctx.rex].filter(Boolean)) console.error(`  log: ${host.log}`);
      failed = true;
      break;
    }
  }
  const after = await teardown(ctx);
  if (after.alive.length > 0 || after.listening.length > 0) {
    console.error(`✗ after teardown: pids still alive ${JSON.stringify(after.alive)}, ports still listening ${JSON.stringify(after.listening)}`);
    failed = true;
  } else {
    console.log(`✓ teardown: hosts stopped by pid, nothing listens on ${after.ports.join(", ")}`);
  }
  clearTimeout(guard);
  if (failed) process.exit(1);
  console.log(`remote-work smoke passed; ${pending.length} step(s) pending: ${[...new Set(pending.map((step) => step.pending))].join(", ")}`);
  // Sockets of the uplinks may linger a moment; nothing else is left to wait for.
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
