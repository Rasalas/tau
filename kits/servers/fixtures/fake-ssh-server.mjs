#!/usr/bin/env node
// A fake SSH/SFTP server for tests and isolated instances only. It listens on
// 127.0.0.1 (nothing else is accepted) with a fresh ed25519 host key on every
// start, lets `tester` in with the test keys of the state folder, the password
// `test`, and optionally a one-time code after either, and:
//  - `exec` runs `/bin/sh -c` in the fake HOME (`<state>/home`), under a pty
//    (node-pty) when the client asked for one;
//  - the `sftp` subsystem runs the machine's own `sftp-server -d <state>/root`;
//  - `direct-tcpip` (ProxyJump) reaches loopback only.
// Every connection, authentication, command and SFTP operation is appended to
// `<state>/calls.log`, an SFTP path outside the fake root and HOME with
// `outside: true`. It is not a sandbox: commands and absolute paths run as the
// user on this machine, so tests keep to the state folder.
//
// CLI: fake-ssh-server.mjs [start] [--dir <state>] [--port <n>] [--otp <code>]
//        [--no-password] [--read-only] [--trust-host-key]
//      fake-ssh-server.mjs stop [--dir <state>]
// `start` prints one JSON line ({ port, pid, fingerprint }), writes it to
// `<state>/fake-ssh.json` and points `Host fake` in `<state>/ssh_config` at the port.
import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ssh2 from "ssh2";
import { appendCall, assertLoopback, isLoopback, paths, prepareServersDir, serversStateDir, TEST_PASSWORD, TEST_USER, writeSshConfig } from "./servers-test-env.mjs";

const { Server, utils } = ssh2;

const SFTP_SERVER_CANDIDATES = [
  "/usr/libexec/sftp-server",
  "/usr/lib/openssh/sftp-server",
  "/usr/libexec/openssh/sftp-server",
  "/usr/lib/ssh/sftp-server",
  "/usr/lib/sftp-server",
];

/** The machine's `sftp-server`; FAKE_SSH_SFTP_SERVER names another. */
export function findSftpServer(env = process.env) {
  if (env.FAKE_SSH_SFTP_SERVER) return env.FAKE_SSH_SFTP_SERVER;
  return SFTP_SERVER_CANDIDATES.find((candidate) => existsSync(candidate));
}

function sameBytes(given, expected) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function fingerprint(publicKey) {
  return `SHA256:${createHash("sha256").update(publicKey.getPublicSSH()).digest("base64").replace(/=+$/u, "")}`;
}

const hostPattern = (port) => (port === 22 ? "127.0.0.1" : `[127.0.0.1]:${port}`);

/** Drops known_hosts lines for this address: a fresh host key makes them stale. */
function forgetHostKeys(knownHosts, port) {
  if (!existsSync(knownHosts)) return;
  const pattern = hostPattern(port);
  const kept = readFileSync(knownHosts, "utf8").split("\n").filter((line) => line && !line.split(/\s+/u)[0].split(",").includes(pattern));
  writeFileSync(knownHosts, kept.length ? `${kept.join("\n")}\n` : "", { mode: 0o600 });
}

/** Paths an `sftp-server` log line names, resolved against the start directory. */
function loggedPaths(line, root) {
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map((match) => (isAbsolute(match[1]) ? resolve(match[1]) : resolve(root, match[1])));
}

const within = (path, folder) => {
  const rel = relative(folder, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

function sessionEnv(home, extra) {
  return {
    HOME: home,
    USER: TEST_USER,
    LOGNAME: TEST_USER,
    SHELL: "/bin/sh",
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    ...extra,
  };
}

async function loadPty() {
  try { return (await import("node-pty")).default; } catch { return undefined; }
}

/** Waits for a stream's buffered data to leave before the exit status is sent after it. */
function drained(stream) {
  return stream.writableNeedDrain ? new Promise((resolvePromise) => stream.once("drain", resolvePromise)) : Promise.resolve();
}

/**
 * Starts the fake on 127.0.0.1. `dir` is the state folder (prepared if
 * needed); `password: null` turns passwords off; `otp` adds a second
 * keyboard-interactive step after the key or password.
 */
export async function startFakeSshServer({
  dir,
  host = "127.0.0.1",
  port = 0,
  user = TEST_USER,
  password = TEST_PASSWORD,
  otp,
  readOnly = false,
  trustHostKey = false,
  sftpServer = findSftpServer(),
} = {}) {
  if (!dir) throw new Error("startFakeSshServer needs the state folder (dir)");
  assertLoopback(host);
  const p = prepareServersDir(dir);
  const log = (record) => appendCall(dir, { tool: "ssh", ...record });
  const authorized = [p.key, p.passphraseKey].map((key) => utils.parseKey(readFileSync(`${key}.pub`, "utf8")));
  const hostKey = utils.generateKeyPairSync("ed25519", { comment: "tau-fake-ssh-host" });
  const hostPublic = utils.parseKey(hostKey.public);
  const children = new Set();
  const clients = new Set();
  const pty = await loadPty();
  // sftp-server logs real paths (/private/tmp on macOS), a caller may name either form.
  const allowed = [p.root, p.home, realpathSync(p.root), realpathSync(p.home)];

  const server = new Server({ hostKeys: [hostKey.private], ident: "TauFakeSSH_1.0" }, (client, info) => {
    const remote = `${info.ip}:${info.port}`;
    clients.add(client);
    if (!isLoopback(info.ip)) {
      log({ event: "refused", remote });
      client.end();
      return;
    }
    log({ event: "connect", remote, client: info.header?.identRaw });
    // What this connection still owes before it is in: the first factor, then the code.
    let firstFactor = false;

    client.on("authentication", (ctx) => {
      const methods = otp && firstFactor ? ["keyboard-interactive"] : ["publickey", "password", "keyboard-interactive"];
      const record = (ok, extra = {}) => log({ event: "auth", method: ctx.method, user: ctx.username, ok, ...extra });
      const passFirstFactor = () => {
        firstFactor = true;
        if (otp) {
          record(true, { partial: true });
          return ctx.reject(["keyboard-interactive"], true);
        }
        record(true);
        return ctx.accept();
      };
      if (ctx.username !== user) {
        record(false, { reason: "unknown user" });
        return ctx.reject(methods);
      }
      if (ctx.method === "publickey" && !firstFactor) {
        const key = authorized.find((candidate) => candidate.type === ctx.key.algo && sameBytes(ctx.key.data, candidate.getPublicSSH()));
        if (!key) { record(false, { reason: "unknown key" }); return ctx.reject(methods); }
        // Without a signature the client only asks whether the key would do.
        if (!ctx.signature) { record(true, { query: true }); return ctx.accept(); }
        if (key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) { record(false, { reason: "bad signature" }); return ctx.reject(methods); }
        return passFirstFactor();
      }
      if (ctx.method === "password" && !firstFactor && password !== null) {
        if (!sameBytes(ctx.password, password)) { record(false); return ctx.reject(methods); }
        return passFirstFactor();
      }
      if (ctx.method === "keyboard-interactive") {
        if (!firstFactor && password !== null) {
          return ctx.prompt([{ prompt: "Password: ", echo: false }], (answers) => {
            if (!sameBytes(answers[0] ?? "", password)) { record(false, { prompt: "password" }); return ctx.reject(methods); }
            return passFirstFactor();
          });
        }
        if (firstFactor && otp) {
          return ctx.prompt([{ prompt: "Verification code: ", echo: false }], (answers) => {
            const ok = sameBytes(answers[0] ?? "", otp);
            record(ok, { prompt: "otp" });
            return ok ? ctx.accept() : ctx.reject(["keyboard-interactive"], true);
          });
        }
      }
      record(false, { reason: "method not offered" });
      return ctx.reject(methods);
    });

    client.on("ready", () => {
      log({ event: "authenticated", user });
      client.on("session", (acceptSession) => handleSession(acceptSession()));
      client.on("tcpip", (accept, reject, request) => {
        if (!isLoopback(request.destIP)) {
          log({ event: "direct-tcpip", to: `${request.destIP}:${request.destPort}`, ok: false });
          return reject();
        }
        log({ event: "direct-tcpip", to: `${request.destIP}:${request.destPort}`, ok: true });
        const socket = connect(request.destPort, request.destIP);
        socket.once("error", () => reject());
        socket.once("connect", () => {
          const channel = accept();
          channel.pipe(socket).pipe(channel);
          channel.on("close", () => socket.destroy());
        });
      });
      client.on("request", (accept, reject, name) => {
        log({ event: "global-request", name, ok: false });
        reject?.();
      });
      client.on("openssh.streamlocal", (accept, reject) => reject());
    });

    client.on("error", (error) => log({ event: "error", message: error.message }));
    client.on("close", () => { clients.delete(client); log({ event: "disconnect", remote }); });

    function handleSession(session) {
      const env = {};
      let ptyInfo;
      let running;
      session.on("env", (accept, reject, variable) => {
        if (/^(LANG|LC_[A-Z]+|TERM)$/u.test(variable.key)) { env[variable.key] = variable.val; accept?.(); } else reject?.();
      });
      session.on("pty", (accept, reject, request) => { ptyInfo = request; accept?.(); });
      session.on("window-change", (accept, reject, size) => { running?.resize?.(size.cols, size.rows); accept?.(); });
      session.on("signal", (accept, reject, signal) => { running?.kill(`SIG${signal.name}`); accept?.(); });
      session.on("auth-agent", (accept, reject) => reject?.());
      session.on("x11", (accept, reject) => reject?.());
      session.on("exec", (accept, reject, request) => {
        log({ event: "exec", command: request.command, pty: Boolean(ptyInfo) });
        running = run(accept(), ["-c", request.command], env, ptyInfo, (code) => log({ event: "exit", command: request.command, code }));
      });
      session.on("shell", (accept) => {
        log({ event: "shell", pty: Boolean(ptyInfo) });
        running = run(accept(), ptyInfo ? ["-l"] : ["-s"], env, ptyInfo, (code) => log({ event: "exit", command: "(shell)", code }));
      });
      session.on("subsystem", (accept, reject, request) => {
        if (request.name !== "sftp" || !sftpServer) {
          log({ event: "subsystem", name: request.name, ok: false });
          return reject?.();
        }
        log({ event: "subsystem", name: "sftp", ok: true });
        const channel = accept();
        const args = ["-e", "-l", "INFO", "-d", p.root, ...(readOnly ? ["-R"] : [])];
        const child = spawn(sftpServer, args, { cwd: p.home, env: sessionEnv(p.home, env), stdio: ["pipe", "pipe", "pipe"] });
        children.add(child);
        channel.pipe(child.stdin);
        child.stdout.pipe(channel);
        let pending = "";
        child.stderr.on("data", (chunk) => {
          pending += chunk;
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines.map((entry) => entry.replace(/\r$/u, "")).filter(Boolean)) {
            const outside = loggedPaths(line, p.root).some((path) => !allowed.some((folder) => within(path, folder)));
            log({ event: "sftp-op", line, ...(outside ? { outside: true } : {}) });
          }
        });
        channel.on("close", () => { if (child.exitCode === null) child.kill("SIGTERM"); });
        child.on("close", () => { children.delete(child); channel.end(); });
      });
    }

    function run(channel, args, env, ptyInfo, onExit) {
      const childEnv = sessionEnv(p.home, env);
      if (ptyInfo && pty) {
        const terminal = pty.spawn("/bin/sh", args, { cwd: p.home, env: { TERM: ptyInfo.term || "xterm", ...childEnv }, cols: ptyInfo.cols || 80, rows: ptyInfo.rows || 24 });
        const handle = { kill: (signal) => terminal.kill(signal), resize: (cols, rows) => terminal.resize(cols, rows) };
        children.add(handle);
        terminal.onData((data) => channel.write(data));
        channel.on("data", (data) => terminal.write(data.toString()));
        channel.on("close", () => { try { terminal.kill(); } catch { /* gone */ } });
        terminal.onExit(async ({ exitCode }) => {
          children.delete(handle);
          onExit(exitCode);
          await drained(channel);
          channel.exit(exitCode);
          channel.end();
        });
        return handle;
      }
      const child = spawn("/bin/sh", args, { cwd: p.home, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
      children.add(child);
      channel.pipe(child.stdin);
      child.stdout.pipe(channel, { end: false });
      child.stderr.pipe(channel.stderr, { end: false });
      channel.on("close", () => { if (child.exitCode === null) child.kill("SIGHUP"); });
      child.stdin.on("error", () => undefined);
      child.on("close", async (code, signal) => {
        children.delete(child);
        onExit(code ?? signal);
        await Promise.all([drained(channel), drained(channel.stderr)]);
        if (signal) channel.exit(signal.replace(/^SIG/u, ""), false, "");
        else channel.exit(code ?? 0);
        channel.end();
      });
      return child;
    }
  });

  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolvePromise(undefined); });
  });
  const bound = server.address().port;
  forgetHostKeys(p.knownHosts, bound);
  const knownHostsLine = `${hostPattern(bound)} ${hostPublic.type} ${hostPublic.getPublicSSH().toString("base64")}`;
  if (trustHostKey) writeFileSync(p.knownHosts, `${readFileSync(p.knownHosts, "utf8")}${knownHostsLine}\n`, { mode: 0o600 });
  writeSshConfig(dir, { sshPort: bound });
  const state = { port: bound, host, pid: process.pid, fingerprint: fingerprint(hostPublic), knownHostsLine, sftpServer: sftpServer ?? null };
  log({ event: "listen", port: bound, fingerprint: state.fingerprint });

  return {
    ...state,
    dir,
    // Resolves once every connection has logged its disconnect, so a caller may remove the folder then.
    close: async () => {
      for (const child of children) { try { child.kill("SIGTERM"); } catch { /* gone */ } }
      const listening = new Promise((resolvePromise) => server.close(() => resolvePromise(undefined)));
      const disconnected = [...clients].map((client) => new Promise((resolvePromise) => {
        client.once("close", resolvePromise);
        client.end();
      }));
      await Promise.all([listening, ...disconnected]);
    },
  };
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function cli(args) {
  const dir = option(args, "--dir") ? resolve(option(args, "--dir")) : serversStateDir();
  if (!dir) {
    process.stderr.write("fake-ssh-server: --dir, FAKE_SERVERS_STATE or TAU_USER_DATA names the state folder\n");
    process.exit(2);
  }
  if (args[0] === "stop") {
    const statePath = paths(dir).sshState;
    let pid;
    try { pid = JSON.parse(readFileSync(statePath, "utf8")).pid; } catch { /* none running */ }
    if (typeof pid === "number") { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
    rmSync(statePath, { force: true });
    return;
  }
  const server = await startFakeSshServer({
    dir,
    port: Number(option(args, "--port") ?? 0),
    otp: option(args, "--otp"),
    password: args.includes("--no-password") ? null : TEST_PASSWORD,
    readOnly: args.includes("--read-only"),
    trustHostKey: args.includes("--trust-host-key"),
  });
  const { close, dir: _dir, ...state } = server;
  writeFileSync(paths(dir).sshState, `${JSON.stringify(state, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(state)}\n`);
  const shutdown = () => {
    rmSync(paths(dir).sshState, { force: true });
    void close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cli(process.argv.slice(2));
