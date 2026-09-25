// What the Servers kit's fakes share, for tests and isolated instances only:
// the state folder (.tau-dev/servers in an instance), the test key pairs, the
// ssh_config every test `ssh`/`sftp` runs with (`-F`), the test ssh-agent and
// calls.log. Nothing here reads ~/.ssh, the real agent or the keychain.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ssh2 from "ssh2";

export const FIXTURES = dirname(fileURLToPath(import.meta.url));
export const TEST_USER = "tester";
export const TEST_PASSWORD = "test";
export const TEST_PASSPHRASE = "test-passphrase";
/** The `Host` alias of the fake SSH server in the test ssh_config; `fake-password` skips the key. */
export const SSH_ALIAS = "fake";

export const paths = (dir) => ({
  dir,
  key: join(dir, "id_ed25519"),
  passphraseKey: join(dir, "id_ed25519_passphrase"),
  sshConfig: join(dir, "ssh_config"),
  knownHosts: join(dir, "known_hosts"),
  agentSocket: join(dir, "agent.sock"),
  agentPid: join(dir, "agent.pid"),
  sshState: join(dir, "fake-ssh.json"),
  ftpState: join(dir, "fake-ftp.json"),
  root: join(dir, "root"),
  home: join(dir, "home"),
  keychain: join(dir, "keychain.json"),
  secretTool: join(dir, "secret-tool.json"),
  calls: join(dir, "calls.log"),
  tls: join(dir, "tls"),
});

/** FAKE_SERVERS_STATE, else `<TAU_USER_DATA>/../servers` (a host started from an instance keeps only the latter). */
export function serversStateDir(env = process.env) {
  if (env.FAKE_SERVERS_STATE) return resolve(env.FAKE_SERVERS_STATE);
  if (env.TAU_USER_DATA) return resolve(env.TAU_USER_DATA, "..", "servers");
  return undefined;
}

export function isLoopback(host) {
  return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host) || /^::ffff:127\./u.test(host);
}

export function assertLoopback(host) {
  if (!isLoopback(host)) throw new Error(`the fake servers listen on loopback only, not ${JSON.stringify(host)}`);
}

/** One JSON line per call; `tool` says which fake wrote it. Never a password. */
export function appendCall(dir, record) {
  appendFileSync(join(dir, "calls.log"), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
}

export function readCalls(dir) {
  if (!existsSync(join(dir, "calls.log"))) return [];
  return readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function writeKeyPair(path, options) {
  if (existsSync(path) && existsSync(`${path}.pub`)) return;
  const pair = ssh2.utils.generateKeyPairSync("ed25519", options);
  writeFileSync(path, pair.private, { mode: 0o600 });
  writeFileSync(`${path}.pub`, `${pair.public}\n`, { mode: 0o644 });
}

/** A path in ssh_config: quoted, and `%` escaped because ssh expands tokens there. */
const configPath = (path) => `"${path.replaceAll("%", "%%")}"`;

/**
 * The test ssh_config. `Host *` pins everything ssh would otherwise take from
 * the user: identity, agent, known_hosts, the macOS keychain.
 */
export function renderSshConfig(dir, { sshPort } = {}) {
  const p = paths(dir);
  const hosts = sshPort === undefined ? [] : [
    `Host ${SSH_ALIAS}`,
    "  HostName 127.0.0.1",
    `  Port ${sshPort}`,
    `  User ${TEST_USER}`,
    "",
    `Host ${SSH_ALIAS}-password`,
    "  HostName 127.0.0.1",
    `  Port ${sshPort}`,
    `  User ${TEST_USER}`,
    "  PubkeyAuthentication no",
    "",
  ];
  return [
    "# Test only (kits/servers/fixtures). Use with `ssh -F <this file>`; nothing here reaches ~/.ssh,",
    "# the real ssh-agent or the keychain. Rewritten whenever the fake SSH server starts.",
    "IgnoreUnknown UseKeychain,WarnWeakCrypto",
    "",
    ...hosts,
    "Host *",
    `  IdentityFile ${configPath(p.key)}`,
    "  IdentitiesOnly yes",
    `  IdentityAgent ${configPath(p.agentSocket)}`,
    `  UserKnownHostsFile ${configPath(p.knownHosts)}`,
    "  GlobalKnownHostsFile /dev/null",
    "  UseKeychain no",
    // The fake's library has no post-quantum key exchange; OpenSSH 10.1+ warns on every connection.
    "  WarnWeakCrypto no",
    "  UpdateHostKeys no",
    "  CheckHostIP no",
    "  HashKnownHosts no",
    "  ForwardAgent no",
    "  ForwardX11 no",
    "  PKCS11Provider none",
    "  ControlMaster no",
    "  ControlPath none",
    "  ConnectTimeout 10",
    "",
  ].join("\n");
}

export function writeSshConfig(dir, options = {}) {
  writeFileSync(paths(dir).sshConfig, renderSshConfig(dir, options), { mode: 0o600 });
}

/** The port a running (or last) fake SSH server wrote down, if any. */
export function recordedSshPort(dir) {
  try { return JSON.parse(readFileSync(paths(dir).sshState, "utf8")).port; } catch { return undefined; }
}

/**
 * Creates the state folder once: test keys (one plain, one with
 * TEST_PASSPHRASE), an empty known_hosts, a fake site and a fake HOME with
 * `tmp/`, and the ssh_config. Idempotent; keys survive, the config is rewritten.
 */
export function prepareServersDir(dir) {
  const p = paths(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeKeyPair(p.key, { comment: "tau-servers-test" });
  writeKeyPair(p.passphraseKey, { comment: "tau-servers-test-passphrase", passphrase: TEST_PASSPHRASE, cipher: "aes256-ctr" });
  if (!existsSync(p.knownHosts)) writeFileSync(p.knownHosts, "", { mode: 0o600 });
  if (!existsSync(p.root)) {
    mkdirSync(join(p.root, "site"), { recursive: true });
    writeFileSync(join(p.root, "site", "index.php"), "<?php echo 'fake site';\n");
  }
  mkdirSync(join(p.home, "tmp"), { recursive: true });
  writeSshConfig(dir, { sshPort: recordedSshPort(dir) });
  return p;
}

/**
 * The environment an isolated instance runs with: the stubs instead of
 * `security`/`secret-tool`, the test ssh_config, the test agent (set even when
 * it is not running, so the login shell's real SSH_AUTH_SOCK never fills the gap)
 * and the loopback guard.
 */
export function serversInstanceEnv(dir) {
  const p = paths(dir);
  return {
    FAKE_SERVERS_STATE: dir,
    TAU_SERVERS_SECURITY_COMMAND: join(FIXTURES, "fake-security.mjs"),
    TAU_SERVERS_SECRET_TOOL_COMMAND: join(FIXTURES, "fake-secret-tool.mjs"),
    TAU_SERVERS_SSH_CONFIG: p.sshConfig,
    TAU_SERVERS_LOOPBACK_ONLY: "1",
    SSH_AUTH_SOCK: p.agentSocket,
  };
}

/** macOS allows 104 bytes for a Unix socket path, Linux 108. */
const SOCKET_PATH_LIMIT = 103;

function agentAnswers(socket, sshAdd) {
  const result = spawnSync(sshAdd, ["-l"], { env: { PATH: process.env.PATH, SSH_AUTH_SOCK: socket }, stdio: "ignore" });
  // 0: keys listed, 1: agent without keys, 2: no agent.
  return result.status === 0 || result.status === 1;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function isSshAgent(pid) {
  if (!isAlive(pid)) return false;
  const result = spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
  return /ssh-agent/u.test(result.stdout ?? "");
}

/**
 * A test ssh-agent on `<dir>/agent.sock` holding the plain test key. An agent
 * already answering there is reused and left alone (`owned: false`); one this
 * call starts is stopped by its PID with `stop()`.
 */
export async function startTestSshAgent(dir, { sshAgent = "ssh-agent", sshAdd = "ssh-add" } = {}) {
  const p = paths(dir);
  if (Buffer.byteLength(p.agentSocket) > SOCKET_PATH_LIMIT) {
    throw new Error(`${p.agentSocket} is longer than a Unix socket path may be; use a shorter worktree path`);
  }
  if (existsSync(p.agentSocket) && agentAnswers(p.agentSocket, sshAdd)) {
    // An earlier run's agent (its PID recorded here, still an ssh-agent) is taken over; any other is left alone.
    let pid;
    try { pid = Number(readFileSync(p.agentPid, "utf8")); } catch { /* started elsewhere */ }
    if (!pid || !isSshAgent(pid)) return { pid: undefined, socket: p.agentSocket, owned: false, stop: () => undefined, exited: Promise.resolve() };
    const stop = () => {
      if (isSshAgent(pid)) process.kill(pid, "SIGTERM");
      rmSync(p.agentPid, { force: true });
    };
    return { pid, socket: p.agentSocket, owned: true, stop, exited: Promise.resolve() };
  }
  rmSync(p.agentSocket, { force: true });
  // -D keeps it in the foreground, so the spawned PID is the agent itself.
  const child = spawn(sshAgent, ["-D", "-a", p.agentSocket], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH } });
  await new Promise((resolvePromise, reject) => {
    let output = "";
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`ssh-agent exited with ${code}: ${output.trim()}`)));
    const onData = (chunk) => {
      output += chunk;
      // It prints this line once the socket listens.
      if (output.includes("SSH_AUTH_SOCK=")) resolvePromise(undefined);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
  });
  child.removeAllListeners("exit");
  child.stdout.resume();
  child.stderr.resume();
  const stop = () => {
    if (child.exitCode === null && isAlive(child.pid)) process.kill(child.pid, "SIGTERM");
    rmSync(p.agentPid, { force: true });
  };
  writeFileSync(p.agentPid, String(child.pid));
  const added = spawnSync(sshAdd, [p.key], { env: { PATH: process.env.PATH, SSH_AUTH_SOCK: p.agentSocket }, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
  if (added.status !== 0) {
    stop();
    throw new Error(`ssh-add failed: ${added.stderr?.trim()}`);
  }
  const exited = new Promise((resolvePromise) => {
    if (child.exitCode !== null) resolvePromise(undefined);
    else child.once("exit", () => resolvePromise(undefined));
  });
  return { pid: child.pid, socket: p.agentSocket, owned: true, stop, exited };
}
