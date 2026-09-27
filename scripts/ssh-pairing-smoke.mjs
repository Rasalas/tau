// `tau machines add --ssh` end to end on this machine: host A ("mini") and
// "rex" are two headless test hosts on 127.0.0.1 (tau-test-host.mjs), and
// rex is reached through the Servers kit's fake SSH server, which runs the
// command a real sshd would (`/bin/sh -c …`) with a HOME of its own. ssh runs
// with the fake's ssh_config (-F), never ~/.ssh. No real machine. First A has
// no window and its host pairs its agents alone; then a stand-in for A's
// window process (the app's own WindowEnvironments and core's window half,
// with a plain box for the keychain) pairs for itself and its agents.
// Needs `npm run build` first.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { paths, readCalls, SSH_ALIAS } from "../kits/servers/fixtures/servers-test-env.mjs";
import { startFakeSshServer } from "../kits/servers/fixtures/fake-ssh-server.mjs";
import { startTestHost, stopTestHost, testHostDir } from "./tau-test-host.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(ROOT, "bin", "tau.mjs");
const STATE = join(ROOT, ".tau-dev", "ssh-pairing");
const A = { name: "ssh-a", machineName: "mini" };
const REX = { name: "ssh-rex", machineName: "rex" };

if (!existsSync(join(ROOT, "dist-electron", "main", "headless.js")) || !existsSync(join(ROOT, "dist-web", "index.html"))) {
  console.error("✗ build first: npm run build");
  process.exit(1);
}
const { HostUplink } = await import(pathToFileURL(join(ROOT, "dist-electron", "main", "host-uplink.js")).href);
const { WindowEnvironments, answerEnvironmentCommand } = await import(pathToFileURL(join(ROOT, "dist-electron", "main", "window-environments.js")).href);

const guard = setTimeout(() => { console.error("✗ the smoke ran into its 180 s guard"); process.exit(1); }, 180_000);
guard.unref();
const step = (name, detail = "") => console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);

/** An owner connection over a host's loopback listener and token. */
function owner(host) {
  return new HostUplink({ url: host.url, token: readFileSync(host.tokenFile, "utf8").trim() });
}

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * A's window process as far as `tau machines` reaches it: the uplink names
 * core's window half, and its calls run on the app's WindowEnvironments.
 */
async function standInWindow(host, hostId, dir) {
  const token = readFileSync(host.tokenFile, "utf8").trim();
  let uplink;
  const environments = new WindowEnvironments({
    catalogPath: join(dir, "environments.json"),
    // Not the keychain: the stand-in keeps keys base64-encoded in its test folder.
    box: { available: () => true, encrypt: (text) => Buffer.from(text).toString("base64"), decrypt: (data) => Buffer.from(data, "base64").toString() },
    logger: quiet,
    deviceName: A.machineName,
    local: { id: hostId, name: A.machineName },
    publish: () => undefined,
    show: async () => undefined,
    agents: {
      add: async (entry) => { await uplink.request("machines-add", [entry]); },
      remove: async (id) => { await uplink.request("machines-remove", [id]); },
    },
  });
  const answer = async (call) => {
    try {
      await uplink.request("client-call-result", [call.callId, await answerEnvironmentCommand(environments, call.command, call.input)]);
    } catch (error) {
      await uplink.request("client-call-result", [call.callId, undefined, error instanceof Error ? error.message : String(error)]).catch(() => undefined);
    }
  };
  uplink = new HostUplink({
    url: host.url,
    token,
    onCall: (call) => void answer(call),
    helloFields: () => ({ windowId: "ssh-pairing-smoke", windowHalves: ["window"], subscription: { threads: [], topics: [] } }),
  });
  environments.setLocalHost(host.url, token);
  await environments.start();
  await uplink.hello();
  return { environments, close: () => { environments.close(); uplink.close(); } };
}

/** What a window's supervisor writes, so `tau` finds the host as it would find the app's. */
function writeHostJson(host) {
  writeFileSync(join(host.userData, "host.json"), JSON.stringify({ pid: host.pid, url: host.url, tokenPath: host.tokenFile, startedAt: host.startedAt, version: "smoke" }));
}

/** `tau …` on this computer (A): its userData, and `ssh` from the stubs folder. */
function tau(args, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

/** Every pairing code written in a file below `dirs`, with the file, for the check that no link was written down. */
function writtenCodes(dirs) {
  const found = [];
  for (const dir of dirs.filter((entry) => existsSync(entry))) {
    let files;
    // A host writes and renames files meanwhile; one that vanished mid-walk is read on the next try.
    for (let attempt = 0; !files && attempt < 5; attempt += 1) {
      try { files = readdirSync(dir, { recursive: true }); } catch { /* again */ }
    }
    for (const file of files ?? []) {
      const path = join(dir, String(file));
      let text;
      try { text = statSync(path).isFile() && statSync(path).size < 20_000_000 ? readFileSync(path, "latin1") : ""; } catch { continue; }
      for (const match of text.matchAll(/pair=([A-Za-z0-9_-]{16,})/gu)) found.push({ code: match[1], path });
    }
  }
  return found;
}

const cleanup = [];
let failed = false;
try {
  rmSync(STATE, { recursive: true, force: true });
  const stubs = join(STATE, "bin");
  const servers = join(STATE, "servers");
  mkdirSync(stubs, { recursive: true });

  const [a, rex] = await Promise.all([
    startTestHost({ name: A.name, fresh: true, login: false }, { machineName: A.machineName }),
    startTestHost({ name: REX.name, fresh: true, login: false }, { machineName: REX.machineName }),
  ]);
  cleanup.push(() => stopTestHost(A.name), () => stopTestHost(REX.name));
  for (const host of [a, rex]) writeHostJson(host);
  step("A and rex listen on loopback", `A ${a.url} (pid ${a.pid}), rex ${rex.url} (pid ${rex.pid})`);

  // `tau` there is this checkout's command line for rex's userData; `ssh` here is the real one with the fake's config.
  const realSsh = execFileSync("/bin/sh", ["-c", "command -v ssh"], { encoding: "utf8" }).trim();
  writeFileSync(join(stubs, "tau"), `#!/bin/sh\nTAU_USER_DATA='${rex.userData}' exec '${process.execPath}' '${CLI}' "$@"\n`);
  writeFileSync(join(stubs, "ssh"), `#!/bin/sh\nexec '${realSsh}' -F '${paths(servers).sshConfig}' "$@"\n`);
  for (const stub of ["tau", "ssh"]) chmodSync(join(stubs, stub), 0o755);
  // The fake's sessions take the PATH of this process.
  process.env.PATH = `${stubs}:${process.env.PATH}`;
  const sshd = await startFakeSshServer({ dir: servers, trustHostKey: true });
  cleanup.push(() => sshd.close());
  step("the fake SSH server answers on 127.0.0.1", `port ${sshd.port}, ${sshd.fingerprint}`);

  const env = { ...process.env, TAU_USER_DATA: a.userData, HOME: a.home };
  delete env.ELECTRON_RUN_AS_NODE;
  const aOwner = owner(a);
  const rexOwner = owner(rex);
  cleanup.push(() => aOwner.close(), () => rexOwner.close());
  const rexId = (await rexOwner.hello()).host.id;
  // A hand-started host makes a link of its own at start; only the command line's must be gone.
  const startLinks = (await rexOwner.request("connections-list")).links.map((link) => link.id).join();
  const DIRS = [testHostDir(A.name), testHostDir(REX.name), STATE];
  const startCodes = new Set(writtenCodes(DIRS).map((entry) => entry.code));

  const first = await tau(["machines", "add", "--ssh", SSH_ALIAS, "--agents", "--access", "read-only"], env);
  if (first.code !== 0 || !/^Paired with rex\.\n {2}agents: connected(?: · \d+ ms)?, read only\n$/u.test(first.stdout)) throw new Error(`the first add ended ${first.code}: ${first.stdout}${first.stderr}`);
  const { machines } = await aOwner.request("machines-list");
  if (machines.length !== 1 || machines[0].id !== rexId || machines[0].status !== "connected" || !machines[0].readOnly) throw new Error(`A's host keeps ${JSON.stringify(machines)}`);
  const rexSide = await rexOwner.request("connections-list");
  const devices = rexSide.clients.map((client) => `${client.label} (${client.access})`);
  if (devices.join() !== "mini · Agents (read-only)" || rexSide.links.map((link) => link.id).join() !== startLinks || rexSide.requests.length !== 0) throw new Error(`rex lists ${JSON.stringify({ devices, links: rexSide.links, requests: rexSide.requests })}`);
  step("tau machines add --ssh pairs A's agents with rex, allowed there with rex's own token", `${first.stdout.trim().replace(/\n\s*/gu, "; ")}; rex lists ${devices.join(", ")}, no link left`);

  const execs = readCalls(servers).filter((call) => call.event === "exec");
  if (execs.length !== 1 || !execs[0].command.startsWith("exec sh -c '") || /pair=|tauc\.|token/u.test(execs[0].command)) throw new Error(`the SSH session ran ${JSON.stringify(execs)}`);
  const written = writtenCodes(DIRS).filter((entry) => !startCodes.has(entry.code));
  if (written.length) throw new Error(`a pairing link was written to ${written.map((entry) => entry.path).join(", ")}`);
  step("the link stayed off argv and disk", `one exec over SSH (${execs[0].command.length} chars of sh, no secret); no file under either host holds a new pairing code`);

  const again = await tau(["machines", "add", "--ssh", SSH_ALIAS, "--agents", "--json"], env);
  const known = JSON.parse(again.stdout || "{}");
  const afterAgain = await rexOwner.request("connections-list");
  if (again.code !== 0 || known.state !== "known" || known.agents?.status !== "connected" || afterAgain.clients.length !== 1 || afterAgain.links.map((link) => link.id).join() !== startLinks) {
    throw new Error(`the second add ended ${again.code}: ${again.stdout}${again.stderr}; rex lists ${afterAgain.clients.length} device(s)`);
  }
  step("a second add only checks the connection", `state ${known.state}, agents ${known.agents.status}; rex still lists one device`);

  const listed = await tau(["machines", "list", "--json"], env);
  const overview = JSON.parse(listed.stdout || "{}");
  if (listed.code !== 0 || overview.window !== false || overview.machines?.[0]?.id !== rexId || overview.machines[0].agents?.status !== "connected") throw new Error(`list answered ${listed.stdout}${listed.stderr}`);
  step("tau machines list --json", JSON.stringify(overview.machines.map((machine) => ({ name: machine.name, agents: machine.agents.status }))));

  const started = Date.now();
  const refused = await tau(["machines", "add", "--ssh", `${SSH_ALIAS}-password`, "--agents"], env);
  if (refused.code !== 1 || !/without a password.*BatchMode=yes/u.test(refused.stderr)) throw new Error(`a login that needs a password ended ${refused.code}: ${refused.stdout}${refused.stderr}`);
  step("a target that would need a password fails at once, without a prompt", `${Date.now() - started} ms: ${refused.stderr.trim()}`);

  const removed = await tau(["machines", "remove", "rex"], env);
  const empty = await aOwner.request("machines-list");
  if (removed.code !== 0 || empty.machines.length !== 0) throw new Error(`remove ended ${removed.code}: ${removed.stdout}${removed.stderr}`);
  step("tau machines remove forgets rex on A", removed.stdout.trim());

  const aId = (await aOwner.hello()).host.id;
  const window = await standInWindow(a, aId, join(STATE, "window"));
  cleanup.push(() => window.close());
  const before = (await rexOwner.request("connections-list")).clients.length;
  const paired = await tau(["machines", "add", "--ssh", SSH_ALIAS, "--agents", "--name", "Rex"], env);
  if (paired.code !== 0 || !/^Paired with Rex\.\n {2}window: connected(?: · \d+ ms)?\n {2}agents: connected(?: · \d+ ms)?\n$/u.test(paired.stdout)) throw new Error(`the add through the window ended ${paired.code}: ${paired.stdout}${paired.stderr}`);
  const saved = window.environments.snapshot().environments.filter((entry) => !entry.local).map((entry) => `${entry.name} ${entry.status}`);
  const agentsNow = (await aOwner.request("machines-list")).machines.map((machine) => `${machine.name} ${machine.status}`);
  const rexNow = (await rexOwner.request("connections-list")).clients;
  const fresh = rexNow.filter((client) => client.companionOf || rexNow.some((other) => other.companionOf === client.id));
  if (saved.join() !== "Rex connected" || agentsNow.join() !== "Rex connected" || rexNow.length !== before + 2 || fresh.map((client) => client.label).sort().join() !== "mini,mini · Agents") {
    throw new Error(`the window keeps ${saved}, A's host ${agentsNow}, rex lists ${JSON.stringify(rexNow.map((client) => client.label))}`);
  }
  step("with a window on A, the window pairs for itself and its agents under one request", `${paired.stdout.trim().replace(/\n\s*/gu, "; ")}; rex lists ${fresh.map((client) => client.label).join(" and ")}`);

  const both = JSON.parse((await tau(["machines", "list", "--json"], env)).stdout || "{}");
  const forgot = await tau(["machines", "remove", "Rex"], env);
  const left = window.environments.snapshot().environments.filter((entry) => !entry.local).length + (await aOwner.request("machines-list")).machines.length;
  if (both.window !== true || both.machines?.[0]?.window?.status !== "connected" || forgot.code !== 0 || left !== 0) throw new Error(`list answered ${JSON.stringify(both)}, remove ${forgot.stdout}${forgot.stderr}, ${left} left`);
  step("list shows both sides, remove forgets both", forgot.stdout.trim());
  const leaked = writtenCodes(DIRS).filter((entry) => !startCodes.has(entry.code));
  if (leaked.length) throw new Error(`a pairing link was written to ${leaked.map((entry) => entry.path).join(", ")}`);
  const sessions = readCalls(servers).filter((call) => call.event === "exec");
  // The login that needed a password never ran a command.
  if (sessions.length !== 3 || sessions.some((call) => call.command !== execs[0].command)) throw new Error(`the SSH sessions ran ${JSON.stringify(sessions.map((call) => call.command.slice(0, 40)))}`);
  step("still no pairing code on disk after both pairings", `${sessions.length} SSH sessions, all the same fixed command`);
} catch (error) {
  failed = true;
  console.error(`✗ ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
} finally {
  for (const close of cleanup.reverse()) await Promise.resolve().then(close).catch((error) => console.error(`  cleanup: ${error.message}`));
}
process.exit(failed ? 1 : 0);
