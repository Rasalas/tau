#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { isMain, main } from "./release.mjs";

/** Exercise the archive that will ship, with its own runtime and temporary state. */
export async function smokePortableHost(archive, version) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u.test(version)) throw new Error("Invalid portable smoke version.");
  const scratch = mkdtempSync(join(tmpdir(), "tau-portable-smoke-"));
  const app = join(scratch, "app"), home = join(scratch, "home"), userData = join(scratch, "data"), workspace = join(scratch, "workspace");
  for (const path of [app, home, userData, workspace]) mkdirSync(path);
  let child, socket;
  let output = "";
  try {
    // Windows' own tar reads zip; Git Bash puts GNU tar first, which cannot and reads "D:" as a host.
    const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
    execFileSync(tar, ["-xf", resolvePath(archive), "-C", app], { timeout: 60_000 });
    // An x64 Mac archive smoked on an arm64 runner goes through Rosetta, whose first translation is slow.
    const slow = process.platform === "darwin" && /-x64\.[^/\\]+$/u.test(archive) && process.arch === "arm64" ? 8 : 1;
    const resources = process.platform === "darwin" ? join(app, "Tau.app", "Contents", "Resources") : join(app, "resources");
    const executable = process.platform === "darwin" ? join(app, "Tau.app", "Contents", "MacOS", "Tau") : join(app, process.platform === "win32" ? "Tau.exe" : "tau");
    const unpacked = join(resources, "app.asar.unpacked");
    const entry = join(unpacked, "dist-electron", "main", "headless.js");
    const cli = join(unpacked, "bin", "tau.mjs");
    for (const path of [executable, entry, cli]) if (!existsSync(path)) throw new Error(`Portable host lacks ${path.slice(app.length + 1)}.`);
    const environment = {
      ...process.env, ELECTRON_RUN_AS_NODE: "1", HOME: home, USERPROFILE: home,
      TAU_USER_DATA: userData, TAU_WORKSPACE: workspace,
      TAU_HOST_TOKEN_FILE: join(userData, "host-token"), TAU_CONFIG_FILE: join(userData, "config.json"),
      PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PI_CODING_AGENT_SESSION_DIR: join(userData, "sessions"),
      TAU_HOST_LISTEN: "127.0.0.1:0", TAU_HOST_LOCAL_FILES: "0",
      TAU_NO_EXTENSIONS: "1", TAU_NO_RUNTIME_UPDATES: "1", TAU_HOST_VERSION: version,
    };
    for (const name of ["TAU_HOST_PROXY_LISTEN", "TAU_HOST_TLS", "TAU_HOST_TLS_CERT", "TAU_HOST_TLS_KEY", "TAU_HOST_URL", "TAU_CONNECT_ENROLLMENT_TOKEN"]) delete environment[name];
    // The CLI and native PTY must run against the archive's dependency tree.
    execFileSync(executable, [cli, "--help"], { env: environment, timeout: 15_000 * slow, stdio: "pipe" });
    const nativeProbe = `const pty=require(${JSON.stringify(join(unpacked, "node_modules", "node-pty"))});const p=pty.spawn(process.platform==='win32'?'cmd.exe':'sh',process.platform==='win32'?['/c','echo portable-native']:['-c','printf portable-native']);let seen='';const timer=setTimeout(()=>{p.kill();process.exit(1)},5000);p.onData(s=>seen+=s);p.onExit(e=>{clearTimeout(timer);process.exit(e.exitCode===0&&seen.includes('portable-native')?0:1)});`;
    execFileSync(executable, ["-e", nativeProbe], { env: environment, timeout: 10_000 * slow, stdio: "pipe" });
    child = spawn(executable, [entry], { cwd: workspace, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { output = (output + chunk.toString()).slice(-32_000); });
    child.stderr.on("data", (chunk) => { output = (output + chunk.toString()).slice(-32_000); });
    let spawnError;
    child.on("error", (error) => { spawnError = error; });
    const deadline = Date.now() + 30_000 * slow;
    while (!/tau-host listening on (ws:\/\/127\.0\.0\.1:\d+)/u.test(output)) {
      if (spawnError || child.exitCode !== null) throw new Error(spawnError?.message ?? `Portable host exited ${child.exitCode}.\n${output}`);
      if (Date.now() >= deadline) throw new Error(`Portable host did not start.\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const url = /tau-host listening on (ws:\/\/127\.0\.0\.1:\d+)/u.exec(output)[1];
    const token = readFileSync(environment.TAU_HOST_TOKEN_FILE, "utf8").trim();
    socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Portable host protocol timed out.")), 15_000 * slow);
      socket.onopen = () => socket.send(JSON.stringify({ type: "hello", id: "smoke", hello: { protocol: 1, token, auxiliary: true } }));
      socket.onerror = () => { clearTimeout(timer); reject(new Error("Portable host socket failed.")); };
      socket.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data));
          if (frame.type === "hello-reply") {
            if (frame.reply.hostVersion !== version || frame.reply.owner !== true || !frame.reply.host?.id) throw new Error("Portable host answered with an unexpected version or owner identity.");
            socket.send(JSON.stringify({ type: "request", request: { id: "resources", method: "host-resources", params: [] } }));
          } else if (frame.type === "response" && frame.response.id === "resources") {
            if (frame.response.error || !frame.response.result) throw new Error("Portable host could not report its resources.");
            clearTimeout(timer); resolve();
          }
        } catch (error) { clearTimeout(timer); reject(error); }
      };
    });
    console.log(`Portable ${process.platform} host ${version} passed CLI, native PTY and authenticated protocol checks.`);
  } finally {
    socket?.close();
    if (child && child.exitCode === null) {
      const exited = once(child, "exit").catch(() => undefined);
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited; clearTimeout(timer);
    }
    rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

if (isMain(import.meta.url)) main(async () => {
  const [archive, version] = process.argv.slice(2);
  if (!archive || !version) throw new Error("usage: portable-host-smoke.mjs <archive> <version>");
  await smokePortableHost(archive, version);
});
