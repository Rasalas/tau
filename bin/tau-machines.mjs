// `tau machines …`: pairs this computer with another one it reaches over SSH,
// lists the machines it keeps and forgets one. Whoever logs in over SSH owns
// that machine's Tau (they could read its host token), so its own command line
// there makes a pairing link and allows this computer's request with the host
// token, without the six digits. The link travels only over the SSH session's
// stdin/stdout, never in argv, the environment or a file. Plain Node, no dependencies.
import { spawn, spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { createInterface } from "node:readline";

export const ACCEPT_ACTION = "accept-ssh";
/** What `accept-ssh` and `add` say to each other over the SSH session, one JSON object per line. */
export const WIRE_VERSION = 1;
/** Short: the link only has to live until this computer asked with it. */
export const LINK_LIFETIME_MS = 2 * 60_000;
/** A pairing request waits two minutes for an answer; the window's reply comes after. */
const PAIR_TIMEOUT_MS = 170_000;
const READY_TIMEOUT_MS = 60_000;
const CONNECTED_TIMEOUT_MS = 20_000;
const POLL_MS = 250;

export const MACHINES_USAGE = `Usage: tau machines add --ssh <target> [--name <name>] [--agents] [--access full|read-only] [--json]
       tau machines list [--json]
       tau machines remove <name or id> [--json]

tau machines add pairs this computer with another machine you reach with
ssh <target> (your ssh config, agent and known_hosts apply; ssh never asks
for a password here). Tau must run on both machines, and the other one must
be reachable over the network (its Settings → Connections → Network access).
Tau's command line there makes a pairing link that lives two minutes and
allows this computer's request with its own host token, so nobody compares
digits. This computer's window keeps the machine, as Settings → Machines does;
--agents also lets this computer's agents work there. --access read-only lets
this computer look but not change anything there. --name names it here.
Pairing a machine again only checks the connection.

tau machines list shows the machines this computer keeps, with how its window
and its agents reach each. tau machines remove forgets one here; the other
machine lists this computer until its owner revokes it there.`;

export function parseMachinesArgs(rest) {
  const [action, ...args] = rest.filter((arg) => arg !== "--");
  if (!action || action === "-h" || action === "--help" || args.includes("-h") || args.includes("--help")) return { help: true };
  if (action === ACCEPT_ACTION) {
    if (args.length) throw new Error(`tau machines ${ACCEPT_ACTION} takes no arguments.`);
    return { action };
  }
  const flags = { json: false, agents: false, access: "full" };
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = () => {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value.`);
      index += 1;
      return next;
    };
    if (arg === "--json") flags.json = true;
    else if (arg === "--agents" && action === "add") flags.agents = true;
    else if (arg === "--ssh" && action === "add") flags.ssh = value();
    else if (arg === "--name" && action === "add") flags.name = value();
    else if (arg === "--access" && action === "add") flags.access = value();
    else if (arg.startsWith("-")) throw new Error(`tau machines ${action} does not know ${arg}.`);
    else positional.push(arg);
  }
  if (action === "add") {
    if (positional.length) throw new Error("tau machines add takes the machine as --ssh <target>.");
    if (!flags.ssh) throw new Error("tau machines add needs --ssh <target>, as you would type it after ssh.");
    if (!/^[^\s-][^\s]{0,254}$/u.test(flags.ssh)) throw new Error(`"${flags.ssh}" is not an ssh target.`);
    if (flags.access !== "full" && flags.access !== "read-only") throw new Error("--access is full or read-only.");
    if (flags.name !== undefined && !flags.name.trim()) throw new Error("--name needs a name.");
    return { action, ...flags };
  }
  if (action === "list") {
    if (positional.length) throw new Error("tau machines list takes no machine.");
    return { action, json: flags.json };
  }
  if (action === "remove") {
    if (positional.length !== 1) throw new Error("tau machines remove takes one machine, by name or id.");
    return { action, machine: positional[0], json: flags.json };
  }
  throw new Error(`Unknown machines action "${action}". ${MACHINES_USAGE}`);
}

/**
 * The command the SSH session runs there, in POSIX sh (wrapped so a fish or
 * zsh login shell runs it the same). It takes `tau` from the PATH or the usual
 * places, else the binary of the running host `host.json` names, and only one
 * whose help knows `tau machines`. No secret is in it.
 */
export const REMOTE_TAU_PLACES = ["$HOME/.local/bin/tau", "/usr/local/bin/tau", "/opt/homebrew/bin/tau", "/usr/bin/tau"];

export function remoteCommand(places = REMOTE_TAU_PLACES) {
  const script = [
    "found=",
    "tau_try() { for part in \"$@\"; do [ -f \"$part\" ] || return 1; done; found=1; \"$@\" --help 2>/dev/null | grep -q \"tau machines\" || return 1; exec \"$@\" machines accept-ssh; }",
    `for c in "$(command -v tau 2>/dev/null)" ${places.map((place) => `"${place}"`).join(" ")}; do [ -n "$c" ] && tau_try "$c"; done`,
    "for f in \"${TAU_USER_DATA:-/nonexistent}/host.json\" \"${XDG_CONFIG_HOME:-$HOME/.config}/tau-pi-desktop-prototype/host.json\" \"$HOME/Library/Application Support/tau-pi-desktop-prototype/host.json\"; do",
    "  [ -f \"$f\" ] || continue",
    "  pid=$(sed -n \"s/.*\\\"pid\\\": *\\([0-9][0-9]*\\).*/\\1/p\" \"$f\" | head -n 1)",
    "  [ -n \"$pid\" ] || continue",
    "  exe=$(readlink \"/proc/$pid/exe\" 2>/dev/null || ps -o comm= -p \"$pid\" 2>/dev/null)",
    "  [ -n \"$exe\" ] || continue",
    "  d=$(dirname \"$exe\")",
    "  export ELECTRON_RUN_AS_NODE=1",
    "  for cli in \"$d/resources/app.asar.unpacked/bin/tau.mjs\" \"$d/../Resources/app.asar.unpacked/bin/tau.mjs\"; do tau_try \"$exe\" \"$cli\"; done",
    "  unset ELECTRON_RUN_AS_NODE",
    "done",
    "if [ -n \"$found\" ]; then echo \"{\\\"type\\\":\\\"error\\\",\\\"code\\\":\\\"old-tau\\\"}\"; else echo \"{\\\"type\\\":\\\"error\\\",\\\"code\\\":\\\"no-tau\\\"}\"; fi",
    "exit 3",
  ].join("\n");
  if (script.includes("'")) throw new Error("the remote script must not contain a single quote");
  return `exec sh -c '${script}'`;
}

/** Never a prompt: BatchMode fails instead of asking for a password or a host key. */
export function sshArgs(target, command = remoteCommand()) {
  return ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "ClearAllForwardings=yes", target, command];
}

/** What ssh's own words on stderr mean for the person who ran the command. */
export function explainSshFailure(target, code, stderr) {
  const said = stderr.trim().split("\n").filter(Boolean).at(-1) ?? "";
  if (/Host key verification failed|No .* host key is known/iu.test(stderr)) {
    return `ssh does not know ${target}'s host key yet. Log in once with \`ssh ${target}\` and accept it, then run this again.`;
  }
  if (/Permission denied|Too many authentication failures/iu.test(stderr)) {
    return `ssh could not log in to ${target} without a password (${said}). Tau never lets ssh ask; set up a key or agent so \`ssh -o BatchMode=yes ${target} true\` works.`;
  }
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/iu.test(stderr)) return `ssh does not know the machine ${target}: ${said}`;
  if (/Connection refused|timed out|No route to host|Network is unreachable|Connection closed/iu.test(stderr)) return `ssh could not reach ${target}: ${said}`;
  return `ssh ${target} ended (exit ${code ?? "?"})${said ? `: ${said}` : " without a word"}.`;
}

/** The first `hostname` line of `ssh -G`: where the target points, after the user's ssh config. */
export function sshTargetIsLoopback(target, run = spawnSync) {
  const result = run("ssh", ["-G", target], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  const name = /^hostname (\S+)$/mu.exec(String(result.stdout ?? ""))?.[1]?.toLowerCase();
  return name === "localhost" || name === "::1" || /^127\.\d+\.\d+\.\d+$/u.test(name ?? "");
}

/**
 * One SSH session running the other machine's `tau machines accept-ssh`:
 * `next()` answers its next JSON line (non-JSON lines, such as a login
 * banner, are skipped), `send` writes one, `end` closes stdin and waits.
 */
export function openSshChannel(target, spawnProcess = spawn) {
  const child = spawnProcess("ssh", sshArgs(target), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { if (stderr.length < 16_384) stderr += chunk; });
  const queue = [];
  const waiters = [];
  const exited = new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: undefined, error }));
    child.once("close", (code) => resolve({ code }));
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || typeof message !== "object") return;
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(message);
    else queue.push(message);
  });
  void exited.then(() => { for (const waiter of waiters.splice(0)) waiter.resolve(undefined); });
  child.stdin.on("error", () => undefined);
  return {
    next(timeoutMs) {
      if (queue.length) return Promise.resolve(queue.shift());
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(undefined);
      return new Promise((resolve) => {
        const waiter = { resolve: (value) => { clearTimeout(timer); resolve(value); } };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          resolve(undefined);
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    send(message) {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    async end() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 10_000);
      const result = await exited;
      clearTimeout(timer);
      return { ...result, stderr };
    },
    async failure() {
      const result = await exited;
      return { ...result, stderr };
    },
    kill() { child.kill(); },
  };
}

const REMOTE_ERRORS = {
  "no-tau": (target) => `${target} has no Tau command line. Install Tau there (the .deb puts \`tau\` on the PATH), start it, and try again.`,
  "old-tau": (target) => `${target} runs a Tau without \`tau machines\`. Update Tau there, and try again.`,
  "no-host": (target, message) => message ?? `Tau is not running on ${target}. Start it there, or run \`tau service install\` there, and try again.`,
};

function remoteError(target, message) {
  const explain = REMOTE_ERRORS[message.code];
  return explain ? explain(target, message.message) : `${target} said: ${message.message ?? message.code ?? "an error"}`;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function linkText(state) {
  if (!state) return "–";
  const parts = [state.status === "connected" && state.roundTripMs !== undefined ? `connected · ${state.roundTripMs} ms` : state.status];
  if (state.readOnly) parts.push("read only");
  if (state.detail && state.status !== "connected") parts.push(state.detail);
  return parts.join(", ");
}

function settled(entry, needs) {
  return needs.every((side) => entry?.[side] && entry[side].status !== "connecting");
}

/** Waits for this computer's connections to the machine to leave "connecting"; answers the last overview entry. */
async function awaitConnection(session, id, needs, timeoutMs, pollMs = POLL_MS) {
  const deadline = Date.now() + timeoutMs;
  let entry;
  for (;;) {
    entry = (await session.request("machines-overview")).machines.find((machine) => machine.id === id);
    if (settled(entry, needs) || Date.now() >= deadline) return entry;
    await wait(pollMs);
  }
}

/**
 * `tau machines add --ssh <target>`: this computer's host (its window when one
 * runs) pairs with the link the other machine's command line made, and that
 * command line allows the request. Idempotent: a machine kept already is only checked.
 */
export async function addMachine(options, io) {
  const { out, session } = io;
  const target = options.ssh;
  const self = session.hello?.host;
  if (!self?.id) throw new Error("This computer's Tau is too old to pair from the command line; update it.");
  const channel = (io.openChannel ?? openSshChannel)(target);
  let finished = false;
  try {
    const ready = await channel.next(io.readyTimeoutMs ?? READY_TIMEOUT_MS);
    if (!ready) {
      const { code, stderr, error } = await channel.failure();
      throw new Error(error ? `Could not run ssh: ${error.message}` : explainSshFailure(target, code, stderr));
    }
    if (ready.type === "error") throw new Error(remoteError(target, ready));
    if (ready.type !== "ready" || !ready.host?.id) throw new Error(`${target} answered something this Tau does not understand; update Tau on both machines.`);
    const machine = ready.host;
    if (machine.id === self.id) throw new Error(`${target} is this computer's own Tau.`);

    const overview = await session.request("machines-overview");
    const known = overview.machines.find((entry) => entry.id === machine.id);
    const needWindow = overview.window && !known?.window;
    const needAgents = options.agents && !known?.agents;
    const sides = [...(overview.window ? ["window"] : []), ...(options.agents || known?.agents ? ["agents"] : [])];
    if (!needWindow && !needAgents) {
      if (!known) throw new Error("No Tau window runs on this computer, so there is nothing to keep the machine but its agents: start Tau here, or add --agents.");
      channel.send({ type: "bye" });
      finished = true;
      const entry = await awaitConnection(session, machine.id, sides.filter((side) => known[side]), io.connectedTimeoutMs ?? CONNECTED_TIMEOUT_MS, io.pollMs);
      return report({ state: "known", machine: { id: machine.id, name: entry?.name ?? known.name }, entry }, options, out);
    }

    // The window asks for itself and its agents under one link; the host alone asks as the agents.
    const label = needWindow ? self.name : `${self.name} · Agents`.slice(0, 60);
    channel.send({ type: "link", version: WIRE_VERSION, label, access: options.access });
    const offered = await channel.next(30_000);
    if (!offered) {
      const { code, stderr } = await channel.failure();
      throw new Error(explainSshFailure(target, code, stderr));
    }
    if (offered.type === "error") throw new Error(remoteError(target, offered));
    const urls = Array.isArray(offered.urls) ? offered.urls : [];
    // A loopback address there is this computer's own here, unless the target is this computer (a test).
    const link = urls.find((entry) => entry.reachability === "network")
      ?? ((io.isLoopbackTarget ?? sshTargetIsLoopback)(target) ? urls.find((entry) => entry.reachability === "loopback") : undefined);
    if (!link) {
      channel.send({ type: "bye" });
      finished = true;
      throw new Error(`${machine.name}'s Tau is reachable only on ${machine.name} itself. Turn on network access there (Settings → Connections → Network access), and try again.`);
    }
    const result = await session.request("machines-pair", [{ link: link.url, agents: options.agents, id: machine.id, ...(options.name ? { name: options.name } : {}) }], PAIR_TIMEOUT_MS);
    channel.send({ type: "done" });
    finished = true;
    if (result.state === "denied") throw new Error(`${machine.name} did not allow this computer${await remoteReason(channel)}.`);
    if (result.state === "expired") throw new Error(`${machine.name} did not answer in time${await remoteReason(channel)}.`);
    if (result.state === "cancelled") throw new Error("The pairing was cancelled on this computer.");
    if (result.state === "failed") throw new Error(result.message);
    const entry = await awaitConnection(session, result.machine.id, sides, io.connectedTimeoutMs ?? CONNECTED_TIMEOUT_MS, io.pollMs);
    return report({ ...result, entry }, options, out);
  } finally {
    if (!finished) channel.send({ type: "bye" });
    const ended = await channel.end();
    if (ended.code && ended.code !== 0 && io.verbose) out(`(ssh ended with ${ended.code})`);
  }
}

/** What the other machine said about a request it did not allow, if it said anything before the session ended. */
async function remoteReason(channel) {
  const message = await channel.next(2_000);
  return message?.type === "failed" && message.message ? `: ${message.message}` : "";
}

function report(result, options, out) {
  const { entry } = result;
  const name = entry?.name ?? result.machine.name;
  if (options.json) {
    out(JSON.stringify({ state: result.state, machine: { id: result.machine.id, name }, ...(entry?.window ? { window: entry.window } : {}), ...(entry?.agents ? { agents: entry.agents } : {}), ...(result.agents && !result.agents.added ? { agentsProblem: result.agents.message } : {}) }));
  } else {
    out(result.state === "known" ? `${name} is paired already.` : `Paired with ${name}.`);
    if (entry?.window) out(`  window: ${linkText(entry.window)}`);
    if (entry?.agents) out(`  agents: ${linkText(entry.agents)}`);
    if (result.agents && !result.agents.added) out(`  agents: ${result.agents.message}`);
  }
  const sides = [entry?.window, entry?.agents].filter(Boolean);
  return sides.length > 0 && sides.every((side) => side.status === "connected") ? 0 : 1;
}

export async function listMachines(options, { out, session }) {
  const overview = await session.request("machines-overview");
  if (options.json) {
    out(JSON.stringify(overview));
    return 0;
  }
  if (!overview.window) out("(No Tau window runs on this computer: only the machines its agents reach are listed.)");
  if (overview.machines.length === 0) {
    out("No machines. Pair one with tau machines add --ssh <target>.");
    return 0;
  }
  const width = Math.max(...overview.machines.map((machine) => machine.name.length));
  for (const machine of overview.machines) {
    const sides = [...(overview.window ? [`window: ${linkText(machine.window)}`] : []), `agents: ${linkText(machine.agents)}`];
    out(`${machine.name.padEnd(width)}  ${machine.id.slice(0, 8)}  ${sides.join("  ")}`);
  }
  return 0;
}

export async function removeMachine(options, { out, session }) {
  const removed = await session.request("machines-forget", [options.machine]);
  if (options.json) {
    out(JSON.stringify(removed));
    return 0;
  }
  const what = [removed.window ? "its window entry" : undefined, removed.agents ? "the agents' key" : undefined].filter(Boolean).join(" and ");
  out(`Forgot ${removed.name}${what ? ` (${what})` : ""}. ${removed.name} lists this computer until its owner revokes it there (Settings → Connections).`);
  return 0;
}

/**
 * `tau machines accept-ssh`, run by `add` on the other machine over SSH.
 * stdout carries JSON lines only. It makes one short link on this machine's
 * host, and allows exactly the request that link brings.
 */
export async function acceptOverSsh(io) {
  const emit = (message) => io.write(`${JSON.stringify(message)}\n`);
  let session;
  try {
    session = await io.connect();
  } catch (error) {
    emit({ type: "error", code: "no-host", ...(error instanceof Error && error.message ? { message: error.message } : {}) });
    return 1;
  }
  const self = session.hello?.host;
  if (!self?.id || session.hello.owner === false) {
    session.close();
    emit({ type: "error", code: "no-host", message: `Tau on ${hostname()} did not take its own host token.` });
    return 1;
  }
  emit({ type: "ready", version: WIRE_VERSION, host: { id: self.id, name: self.name, version: session.hello.hostVersion } });
  let link;
  let settled = false;
  let stop = false;
  const pollMs = io.pollMs ?? POLL_MS;
  const allow = async (access) => {
    const deadline = Date.parse(link.expiresAt) + 5_000;
    while (!stop && Date.now() < deadline) {
      const { requests } = await session.request("connections-list");
      const request = requests.find((entry) => entry.link?.id === link.id);
      if (request) {
        settled = true;
        try {
          const { approved } = await session.request("connections-approve", [request.id, { access }]);
          emit(approved ? { type: "approved" } : { type: "failed", message: "the request stopped waiting before it was allowed" });
        } catch (error) {
          // Denied, so the other side hears it now rather than in two minutes.
          await session.request("connections-deny", [request.id]).catch(() => undefined);
          emit({ type: "failed", message: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      await wait(pollMs);
    }
    if (!stop) emit({ type: "expired" });
  };
  let allowing;
  try {
    for await (const line of io.lines) {
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message?.type === "link" && !link) {
        const access = message.access === "read-only" ? "read-only" : "full";
        const label = typeof message.label === "string" ? message.label.slice(0, 60) : undefined;
        const created = await session.request("connections-create-link", [{ ...(label ? { label } : {}), lifetimeMs: LINK_LIFETIME_MS, access }]);
        link = created.link;
        emit({ type: "link", urls: created.urls.map((entry) => ({ url: entry.url, reachability: entry.reachability, ...(entry.kind ? { kind: entry.kind } : {}) })), expiresAt: link.expiresAt });
        allowing = allow(access).catch((error) => emit({ type: "failed", message: error instanceof Error ? error.message : String(error) }));
      } else if (message?.type === "done" || message?.type === "bye") {
        break;
      }
    }
  } finally {
    stop = true;
    await allowing;
    // A link nobody used goes now, not in two minutes.
    if (link && !settled) await session.request("connections-revoke-link", [link.id]).catch(() => undefined);
    session.close();
  }
  return 0;
}

/** Runs one `tau machines` action against this computer's running host. */
export async function runMachines(options, io) {
  if (options.help) { io.out(MACHINES_USAGE); return 0; }
  if (options.action === ACCEPT_ACTION) {
    return acceptOverSsh({
      write: io.write ?? ((text) => process.stdout.write(text)),
      lines: io.lines ?? createInterface({ input: process.stdin }),
      connect: async () => {
        const host = io.readHost();
        if (!host) throw new Error(`Tau is not running on ${hostname()}. Start it there, or run \`tau service install\` there, and try again.`);
        return io.openSession(host);
      },
      ...(io.pollMs ? { pollMs: io.pollMs } : {}),
    });
  }
  const host = io.readHost();
  if (!host) throw new Error("Tau is not running on this computer. Start it (or run tau service install), then try again.");
  const session = await io.openSession(host);
  try {
    const context = { ...io, session };
    if (options.action === "add") return await addMachine(options, context);
    if (options.action === "list") return await listMachines(options, context);
    return await removeMachine(options, context);
  } finally {
    session.close();
  }
}
