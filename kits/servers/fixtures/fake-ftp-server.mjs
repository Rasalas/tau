#!/usr/bin/env node
// A fake FTP/FTPS server (ftp-srv) for tests and isolated instances only, on
// 127.0.0.1 with passive ports on 127.0.0.1. `tester`/`test` sees
// `<state>/root` (the fake SSH server's site too). Modes:
//  - plain:    no TLS at all (AUTH TLS is refused);
//  - explicit: AUTH TLS offered with a self-signed certificate for 127.0.0.1
//              (`<state>/tls/cert.pem`); `--require-tls` refuses a login before it;
//  - implicit: TLS from the first byte.
// Every command (PASS redacted), login and whether the control connection was
// encrypted go to `<state>/calls.log` with `tool: "ftp"`.
//
// Run it as its own process: ftp-srv exits the process on SIGTERM/SIGINT.
// CLI: fake-ftp-server.mjs [start] [--dir <state>] [--port <n>]
//        [--mode plain|explicit|implicit] [--require-tls]
//      fake-ftp-server.mjs stop [--dir <state>]
// `start` prints one JSON line ({ port, pid, mode, cert }) and writes it to `<state>/fake-ftp.json`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import FtpSrv from "ftp-srv";
import { appendCall, assertLoopback, paths, prepareServersDir, serversStateDir, TEST_PASSWORD, TEST_USER } from "./servers-test-env.mjs";

/** A self-signed certificate for 127.0.0.1 under `<state>/tls`, made once with the machine's openssl. */
export function ensureTlsCertificate(dir) {
  const folder = paths(dir).tls;
  const cert = join(folder, "cert.pem");
  const key = join(folder, "key.pem");
  if (!existsSync(cert) || !existsSync(key)) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", key, "-out", cert, "-days", "365", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ], { stdio: "ignore" });
  }
  return { cert, key };
}

const quiet = {
  child() { return quiet; },
  trace() {}, debug() {}, info() {}, warn() {},
  error(...args) { process.stderr.write(`fake-ftp-server: ${args.map((arg) => (arg instanceof Error ? arg.message : typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")}\n`); },
  fatal(...args) { quiet.error(...args); },
};

export async function startFakeFtpServer({ dir, host = "127.0.0.1", port = 0, mode = "explicit", requireTls = false, user = TEST_USER, password = TEST_PASSWORD } = {}) {
  if (!dir) throw new Error("startFakeFtpServer needs the state folder (dir)");
  if (!["plain", "explicit", "implicit"].includes(mode)) throw new Error(`unknown mode ${JSON.stringify(mode)}`);
  assertLoopback(host);
  const p = prepareServersDir(dir);
  const log = (record) => appendCall(dir, { tool: "ftp", ...record });
  const certificate = mode === "plain" ? undefined : ensureTlsCertificate(dir);
  const tls = certificate ? { cert: readFileSync(certificate.cert), key: readFileSync(certificate.key) } : false;
  // ftp-srv takes passive ports upward from pasv_min; a random start keeps parallel fakes apart.
  const pasvMin = 40_000 + Math.floor(Math.random() * 20_000);
  const server = new FtpSrv({
    url: `${mode === "implicit" ? "ftps" : "ftp"}://${host}:${port}`,
    pasv_url: host,
    pasv_min: pasvMin,
    pasv_max: pasvMin + 500,
    anonymous: false,
    tls,
    log: quiet,
    greeting: ["Tau fake FTP server"],
  });

  server.on("connect", ({ connection }) => {
    log({ event: "connect", remote: `${connection.ip}`, tls: connection.secure });
    const handle = connection.commands.handle.bind(connection.commands);
    connection.commands.handle = (command) => {
      const parsed = typeof command === "string" ? connection.commands.parse(command) : command;
      log({ event: "command", directive: parsed.directive, arg: parsed.directive === "PASS" ? "********" : parsed.arg, tls: connection.secure });
      return handle(parsed);
    };
  });
  server.on("disconnect", ({ connection }) => log({ event: "disconnect", remote: `${connection.ip}` }));
  server.on("login", ({ connection, username, password: given }, resolveLogin, rejectLogin) => {
    if (requireTls && !connection.secure) {
      log({ event: "login", user: username, ok: false, reason: "TLS required", tls: false });
      return rejectLogin(new Error("TLS required"));
    }
    const ok = username === user && given === password;
    log({ event: "login", user: username, ok, tls: connection.secure });
    return ok ? resolveLogin({ root: p.root, cwd: "/" }) : rejectLogin(new Error("Login incorrect"));
  });

  await server.listen();
  const bound = server.server.address().port;
  const state = { port: bound, host, pid: process.pid, mode, requireTls, cert: certificate?.cert ?? null };
  log({ event: "listen", ...state });
  return { ...state, close: () => server.close() };
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function cli(args) {
  const dir = option(args, "--dir") ? resolve(option(args, "--dir")) : serversStateDir();
  if (!dir) {
    process.stderr.write("fake-ftp-server: --dir, FAKE_SERVERS_STATE or TAU_USER_DATA names the state folder\n");
    process.exit(2);
  }
  const statePath = paths(dir).ftpState;
  if (args[0] === "stop") {
    let pid;
    try { pid = JSON.parse(readFileSync(statePath, "utf8")).pid; } catch { /* none running */ }
    if (typeof pid === "number") { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
    rmSync(statePath, { force: true });
    return;
  }
  const { close, ...state } = await startFakeFtpServer({
    dir,
    port: Number(option(args, "--port") ?? 0),
    mode: option(args, "--mode") ?? "explicit",
    requireTls: args.includes("--require-tls"),
  });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(state)}\n`);
  // ftp-srv's own handler closes and exits a moment later.
  const forget = () => rmSync(statePath, { force: true });
  process.on("SIGTERM", forget);
  process.on("SIGINT", forget);
  void close;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cli(process.argv.slice(2));
