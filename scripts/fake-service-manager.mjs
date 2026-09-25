#!/usr/bin/env node
// Stands in for launchctl, systemctl and loginctl when TAU_SERVICE_CONTROL
// names this file (`src/main/host-service.ts`): a dev instance and the window
// host smoke install Tau's host "as a service" without the machine's service
// manager ever hearing of it. It starts the unit's program itself, detached,
// with the unit's environment, and keeps the pid in a state file beside the
// units (TAU_SERVICE_UNIT_DIR). Every call is appended to `.fake-calls.log`
// there. A systemd unit's `Wants=`/`BindsTo=` start with it, and a unit bound
// to one that stops stops too (the display's Xvfb and window). Task Scheduler
// is not faked. Never used by the app.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const xmlText = (value) => value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", "\"").replaceAll("&amp;", "&");

/** The parts of a LaunchAgent `renderLaunchAgent` writes that starting it needs. */
export function parseLaunchAgent(text) {
  const label = xmlText(/<key>Label<\/key>\s*<string>([^<]*)<\/string>/u.exec(text)?.[1] ?? "");
  const programBlock = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(text)?.[1] ?? "";
  const program = [...programBlock.matchAll(/<string>([^<]*)<\/string>/gu)].map((match) => xmlText(match[1]));
  const envBlock = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/u.exec(text)?.[1] ?? "";
  const env = Object.fromEntries([...envBlock.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/gu)].map((match) => [xmlText(match[1]), xmlText(match[2])]));
  const cwd = xmlText(/<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/u.exec(text)?.[1] ?? "");
  const log = xmlText(/<key>StandardOutPath<\/key>\s*<string>([^<]*)<\/string>/u.exec(text)?.[1] ?? "");
  return { label, program, env, cwd, log };
}

const systemdText = (value) => value.replace(/\\(["\\])/gu, "$1").replaceAll("%%", "%");

/** The parts of a unit `renderSystemdUnit` writes that starting it needs. */
export function parseSystemdUnit(text, home) {
  const env = {};
  for (const match of text.matchAll(/^Environment="((?:\\.|[^"\\])*)"$/gmu)) {
    const assignment = systemdText(match[1]);
    const equals = assignment.indexOf("=");
    env[assignment.slice(0, equals)] = assignment.slice(equals + 1);
  }
  const exec = /^ExecStart=(.*)$/mu.exec(text)?.[1] ?? "";
  const program = [...exec.matchAll(/"((?:\\.|[^"\\])*)"/gu)].map((match) => systemdText(match[1]).replaceAll("$$", "$"));
  const log = (/^StandardOutput=append:(.*)$/mu.exec(text)?.[1] ?? "").replaceAll("%%", "%");
  return { program, env, cwd: home, log };
}

/** The units a unit pulls in (`Wants=`, `BindsTo=`) and the ones it stops with (`BindsTo=`). */
export function systemdDependencies(text) {
  const list = (key) => [...text.matchAll(new RegExp(`^${key}=(.*)$`, "gmu"))].flatMap((match) => match[1].trim().split(/\s+/u)).filter(Boolean);
  const bindsTo = list("BindsTo");
  return { pulls: [...list("Wants"), ...bindsTo], bindsTo };
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function unitDirectory() {
  const directory = process.env.TAU_SERVICE_UNIT_DIR;
  if (!directory) throw new Error("fake service manager: TAU_SERVICE_UNIT_DIR is not set");
  mkdirSync(directory, { recursive: true });
  return directory;
}

function readState(directory) {
  try { return JSON.parse(readFileSync(join(directory, ".fake-state.json"), "utf8")); } catch { return {}; }
}

function writeState(directory, state) {
  writeFileSync(join(directory, ".fake-state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

/** A service manager's environment is its own, not the caller's: only the login basics and the unit's. */
function start(unit) {
  const base = {};
  for (const key of ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "ZDOTDIR", "SystemRoot"]) if (process.env[key]) base[key] = process.env[key];
  mkdirSync(dirname(unit.log), { recursive: true });
  const log = openSync(unit.log, "a");
  const child = spawn(unit.program[0], unit.program.slice(1), {
    cwd: unit.cwd || process.env.HOME,
    env: { ...base, ...unit.env },
    stdio: ["ignore", log, log],
    detached: true,
  });
  child.unref();
  return child.pid;
}

async function stop(pid) {
  if (!alive(pid)) return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && alive(pid)) await new Promise((resolve) => setTimeout(resolve, 100));
  if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
}

async function launchctl(args, directory, state) {
  const [verb, ...rest] = args;
  const target = rest.filter((arg) => !arg.startsWith("-")).at(-1) ?? "";
  const label = target.split("/").pop();
  const entry = state[label];
  switch (verb) {
    case "bootstrap": {
      const plist = rest.at(-1);
      const unit = parseLaunchAgent(readFileSync(plist, "utf8"));
      if (state[unit.label]?.loaded) { console.error("Bootstrap failed: 5: Input/output error"); return 5; }
      state[unit.label] = { loaded: true, unitPath: plist, pid: start(unit) };
      return 0;
    }
    case "bootout":
      if (!entry?.loaded) { console.error("Boot-out failed: 3: No such process"); return 3; }
      await stop(entry.pid);
      delete state[label];
      return 0;
    case "enable":
      return 0;
    case "kickstart": {
      if (!entry?.loaded) { console.error("Could not find service"); return 113; }
      if (rest.includes("-k")) await stop(entry.pid);
      if (!alive(entry.pid)) entry.pid = start(parseLaunchAgent(readFileSync(entry.unitPath, "utf8")));
      return 0;
    }
    case "print":
      if (!entry?.loaded) { console.error(`Could not find service "${label}"`); return 113; }
      console.log(`${target} = {\n\tstate = ${alive(entry.pid) ? "running" : "not running"}\n\tpid = ${entry.pid}\n}`);
      return 0;
    default:
      console.error(`fake launchctl: ${verb} is not faked`);
      return 64;
  }
}

function unitText(directory, name) {
  try { return readFileSync(join(directory, name), "utf8"); } catch { return undefined; }
}

function startUnit(directory, state, name) {
  const text = unitText(directory, name);
  if (text === undefined) { console.error(`Unit ${name} not found.`); return 5; }
  for (const dependency of systemdDependencies(text).pulls) {
    const code = startUnit(directory, state, dependency);
    if (code !== 0 && systemdDependencies(text).bindsTo.includes(dependency)) return code;
  }
  const entry = (state[name] ??= {});
  if (!alive(entry.pid)) entry.pid = start(parseSystemdUnit(text, process.env.HOME));
  return 0;
}

/** Stops a unit and, first, every running unit bound to it; the state keeps no file of a removed unit. */
async function stopUnit(directory, state, name) {
  for (const [other, entry] of Object.entries(state)) {
    if (other === name || !alive(entry.pid)) continue;
    const text = unitText(directory, other);
    if (text && systemdDependencies(text).bindsTo.includes(name)) await stopUnit(directory, state, other);
  }
  const entry = state[name];
  if (!entry) return;
  await stop(entry.pid);
  entry.pid = undefined;
}

async function systemctl(args, directory, state) {
  const [verb, unitName] = args.filter((arg) => arg !== "--user");
  const entry = unitName ? (state[unitName] ??= {}) : undefined;
  switch (verb) {
    case "daemon-reload": return 0;
    case "show-environment": console.log(`HOME=${process.env.HOME}`); return 0;
    case "enable": entry.enabled = true; return 0;
    case "disable": entry.enabled = false; return 0;
    case "start": return startUnit(directory, state, unitName);
    case "restart": await stopUnit(directory, state, unitName); return startUnit(directory, state, unitName);
    case "stop": await stopUnit(directory, state, unitName); return 0;
    case "is-enabled": console.log(entry.enabled ? "enabled" : "disabled"); return entry.enabled ? 0 : 1;
    case "is-active": console.log(alive(entry.pid) ? "active" : "inactive"); return alive(entry.pid) ? 0 : 3;
    default:
      console.error(`fake systemctl: ${verb} is not faked`);
      return 64;
  }
}

function loginctl(args) {
  if (args[0] === "show-user") { console.log("yes"); return 0; }
  if (args[0] === "enable-linger") return 0;
  console.error(`fake loginctl: ${args[0]} is not faked`);
  return 64;
}

export async function main(argv) {
  const [tool, ...args] = argv;
  const directory = unitDirectory();
  appendFileSync(join(directory, ".fake-calls.log"), `${[tool, ...args].join(" ")}\n`);
  const state = readState(directory);
  let code;
  if (tool === "launchctl") code = await launchctl(args, directory, state);
  else if (tool === "systemctl") code = await systemctl(args, directory, state);
  else if (tool === "loginctl") code = loginctl(args);
  else { console.error(`fake service manager: ${tool} is not faked`); code = 64; }
  writeState(directory, state);
  return code;
}

const invokedDirectly = (() => {
  try { return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 70;
  });
}
