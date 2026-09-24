#!/usr/bin/env node
// A stand-in for the `tailscale` CLI, for tests and an isolated Tau only. It
// never talks to tailscaled or a tailnet. It answers `status --json`,
// `serve status --json`, `serve --bg --https=<port> <target>`,
// `serve --https=<port> [--set-path=<path>] off` and `serve reset`, keeping
// Serve's config in FAKE_TAILSCALE_STATE/state.json in `ipn.ServeConfig`'s
// shape. Every call is appended to FAKE_TAILSCALE_STATE/calls.log; anything
// else (`funnel`, `cert`, `set`, `up`) is refused with exit code 2.
//
// While a port has a handler, a background process stands in for Serve on
// 127.0.0.1: the port itself, or FAKE_TAILSCALE_LOW_PORT_BASE + port below
// 1024 (18000 + 443 = 18443). It speaks plain HTTP (a real Serve terminates
// TLS with a Let's Encrypt certificate) and forwards the way Serve's reverse
// proxy does (tailscale/ipn/ipnlocal/serve.go): the Host header kept,
// X-Forwarded-Host/-Proto/-For set afresh, Tailscale-User-Login, -Name and
// -Profile-Pic set for an untagged peer and stripped from what the client
// sent, the name Q-encoded outside ASCII, WebSocket upgrades passed through.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.env.FAKE_TAILSCALE_STATE;
if (!dir) {
  process.stderr.write("fake-tailscale: FAKE_TAILSCALE_STATE names the folder the fake keeps its state in\n");
  process.exit(2);
}
mkdirSync(dir, { recursive: true });
const stateFile = join(dir, "state.json");
const lowPortBase = Number(process.env.FAKE_TAILSCALE_LOW_PORT_BASE ?? 18000);

const DEFAULT_STATE = {
  backendState: "Running",
  dnsName: "tau-test-box.tail0000.ts.net",
  hostName: "tau-test-box",
  magicDns: true,
  https: true,
  addresses: ["100.101.102.1", "fd7a:115c:a1e0::1"],
  user: { loginName: "alice@example.com", displayName: "Alice Example", profilePicURL: "https://example.com/alice.png" },
  peer: "100.101.102.103",
  tagged: false,
  serve: {},
  daemons: {},
};

function load() {
  return existsSync(stateFile) ? { ...DEFAULT_STATE, ...JSON.parse(readFileSync(stateFile, "utf8")) } : { ...DEFAULT_STATE };
}

function save(state) {
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

function listenPort(port) {
  return port < 1024 ? lowPortBase + port : port;
}

const args = process.argv.slice(2);
if (args[0] === "__serve") {
  daemon(Number(args[1]));
} else {
  appendFileSync(join(dir, "calls.log"), `${JSON.stringify(args)}\n`);
  cli(args);
}

function cli(argv) {
  const state = load();
  if (argv[0] === "status" && argv.includes("--json")) return print(statusJson(state));
  if (argv[0] !== "serve") return refuse(`fake-tailscale: "${argv.join(" ")}" is not simulated`);
  const rest = argv.slice(1);
  if (rest[0] === "status") return print(rest.includes("--json") ? JSON.stringify(state.serve, null, 2) : describe(state));
  if (rest[0] === "reset") {
    state.serve = {};
    stopDaemons(state, () => true);
    return save(state);
  }
  if (state.backendState !== "Running") return fail("Tailscale is stopped.", 1);
  if (process.env.FAKE_TAILSCALE_DENY === "1") return fail("Access denied: serve config denied\nUse 'sudo tailscale serve' or 'sudo tailscale set --operator=$USER'.", 1);
  const https = Number(flag(rest, "--https"));
  if (!Number.isInteger(https) || https < 1) return fail("fake-tailscale: --https=<port> is required", 1);
  const path = flag(rest, "--set-path") ?? "/";
  const hostPort = `${state.dnsName}:${https}`;
  const positional = rest.filter((arg) => !arg.startsWith("--"));
  if (positional.at(-1) === "off") {
    const handlers = state.serve.Web?.[hostPort]?.Handlers ?? {};
    if (flag(rest, "--set-path") !== undefined) {
      if (!handlers[path]) return fail("error: handler does not exist", 1);
      delete handlers[path];
    } else {
      for (const key of Object.keys(handlers)) delete handlers[key];
    }
    if (Object.keys(handlers).length === 0) {
      if (state.serve.Web) delete state.serve.Web[hostPort];
      if (state.serve.TCP) delete state.serve.TCP[String(https)];
      stopDaemons(state, (port) => port === https);
    }
    tidy(state.serve);
    return save(state);
  }
  if (!rest.includes("--bg")) return fail("fake-tailscale: only --bg is simulated; a foreground serve would hold the terminal", 2);
  if (!state.https) {
    // The real CLI offers to turn HTTPS on and waits for the admin to do it.
    process.stdout.write(`Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=FAKE\n\n`);
    setInterval(() => undefined, 60_000);
    return undefined;
  }
  const target = positional.at(-1);
  if (!target) return fail("fake-tailscale: a target is required", 1);
  const proxy = /^\d+$/u.test(target) ? `http://127.0.0.1:${target}` : target;
  state.serve.TCP = { ...state.serve.TCP, [String(https)]: { HTTPS: true } };
  state.serve.Web = { ...state.serve.Web, [hostPort]: { Handlers: { ...state.serve.Web?.[hostPort]?.Handlers, [path]: { Proxy: proxy } } } };
  save(state);
  startDaemon(state, https);
  return print(`Available within your tailnet:\n\nhttps://${state.dnsName}${https === 443 ? "" : `:${https}`}/\n|-- proxy ${proxy}\n\nServe started and running in the background.\nTo disable the proxy, run: tailscale serve --https=${https} off`);
}

function statusJson(state) {
  const running = state.backendState === "Running";
  return JSON.stringify({
    Version: "1.102.4-fake",
    TUN: running,
    BackendState: state.backendState,
    HaveNodeKey: state.backendState !== "NeedsLogin",
    AuthURL: "",
    TailscaleIPs: running ? state.addresses : [],
    Self: {
      ID: "fake",
      HostName: state.hostName,
      DNSName: `${state.dnsName}.`,
      OS: process.platform,
      TailscaleIPs: running ? state.addresses : [],
      Online: running,
      Tags: state.tagged ? ["tag:server"] : null,
    },
    Health: [],
    MagicDNSSuffix: state.dnsName.split(".").slice(1).join("."),
    CurrentTailnet: { Name: "fake@example.com", MagicDNSSuffix: state.dnsName.split(".").slice(1).join("."), MagicDNSEnabled: state.magicDns },
    CertDomains: state.https ? [state.dnsName] : null,
    Peer: {},
    User: {},
  }, null, 2);
}

function describe(state) {
  const lines = Object.entries(state.serve.Web ?? {}).flatMap(([hostPort, web]) =>
    Object.entries(web.Handlers ?? {}).map(([path, handler]) => `https://${hostPort}${path} proxy ${handler.Proxy}`));
  return lines.length ? lines.join("\n") : "No serve config";
}

function flag(list, name) {
  const inline = list.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = list.indexOf(name);
  return index >= 0 ? list[index + 1] : undefined;
}

function tidy(serve) {
  for (const key of ["TCP", "Web"]) if (serve[key] && Object.keys(serve[key]).length === 0) delete serve[key];
}

function print(text) {
  process.stdout.write(`${text}\n`);
}

function fail(text, code) {
  process.stderr.write(`${text}\n`);
  process.exitCode = code;
}

function refuse(text) {
  fail(text, 2);
}

function startDaemon(state, port) {
  if (state.daemons[port] && alive(state.daemons[port])) return;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "__serve", String(port)], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
  state.daemons[port] = child.pid;
  save(state);
}

function stopDaemons(state, which) {
  for (const [port, pid] of Object.entries(state.daemons)) {
    if (!which(Number(port))) continue;
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    delete state.daemons[port];
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Serve's identity headers carry a name outside ASCII as an RFC 2047 Q-word. */
function qEncode(value) {
  if (/^[\x20-\x7e]*$/u.test(value)) return value;
  const bytes = Buffer.from(value, "utf8");
  let out = "";
  for (const byte of bytes) {
    // Go's mime.QEncoding keeps printable ASCII but for `=`, `?` and `_`.
    const plain = byte > 0x20 && byte < 0x7f && !"=?_".includes(String.fromCharCode(byte));
    out += plain ? String.fromCharCode(byte) : byte === 0x20 ? "_" : `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return `=?utf-8?q?${out}?=`;
}

const DROPPED = ["tailscale-user-login", "tailscale-user-name", "tailscale-user-profile-pic", "tailscale-funnel-request", "tailscale-headers-info", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded"];

function rewrite(headers, state) {
  const out = { ...headers };
  for (const name of DROPPED) delete out[name];
  out["x-forwarded-host"] = headers.host ?? "";
  out["x-forwarded-proto"] = "https";
  out["x-forwarded-for"] = state.peer;
  if (!state.tagged) {
    out["tailscale-user-login"] = qEncode(state.user.loginName);
    out["tailscale-user-name"] = qEncode(state.user.displayName);
    out["tailscale-user-profile-pic"] = state.user.profilePicURL;
    out["tailscale-headers-info"] = "https://tailscale.com/s/serve-headers";
  }
  return out;
}

/** The handler for a path: the longest mount point it falls under. */
function upstreamFor(state, port, path) {
  const handlers = state.serve.Web?.[`${state.dnsName}:${port}`]?.Handlers ?? {};
  const mount = Object.keys(handlers).filter((entry) => path === entry || path.startsWith(entry.endsWith("/") ? entry : `${entry}/`)).sort((a, b) => b.length - a.length)[0];
  const proxy = mount ? handlers[mount].Proxy : undefined;
  return proxy ? new URL(proxy) : undefined;
}

function daemon(port) {
  const server = createServer((req, res) => {
    const state = load();
    const upstream = upstreamFor(state, port, req.url ?? "/");
    if (!upstream) { res.writeHead(404).end(); return; }
    const forward = httpRequest({ host: upstream.hostname, port: upstream.port || 80, method: req.method, path: req.url, headers: rewrite(req.headers, state) }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    // Serve answers 502 when the backend is not listening.
    forward.once("error", () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
    req.pipe(forward);
  });
  server.on("upgrade", (req, socket, head) => {
    const state = load();
    const upstream = upstreamFor(state, port, req.url ?? "/");
    if (!upstream) { socket.destroy(); return; }
    const backend = connect(Number(upstream.port || 80), upstream.hostname, () => {
      const headers = rewrite(req.headers, state);
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((entry) => `${name}: ${entry}`))];
      backend.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) backend.write(head);
      backend.pipe(socket);
      socket.pipe(backend);
    });
    backend.once("error", () => socket.destroy());
    socket.once("error", () => backend.destroy());
  });
  server.listen(listenPort(port), "127.0.0.1");
  // Gone once Serve no longer forwards anything on its port.
  setInterval(() => {
    const state = load();
    if (!state.serve.Web?.[`${state.dnsName}:${port}`]) process.exit(0);
  }, 1_000).unref();
  process.on("SIGTERM", () => process.exit(0));
}
