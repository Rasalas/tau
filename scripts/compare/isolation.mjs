// Guards for running both apps without touching the user's own data.
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/** Directories no compared process may open, whatever its environment says. */
export function forbiddenPaths(home = homedir()) {
  const electronApps = ["tau", "tau-pi-desktop-prototype", "t3code", "t3code-v2", "t3code-dev", "T3 Code (Alpha)", "T3 Code (Beta)", "T3 Code (Dev)"];
  return [
    // The reference app's data folders.
    join(home, ".t3"),
    join(home, ".tau"),
    join(home, ".codex"),
    join(home, ".claude"),
    join(home, ".pi"),
    ...electronApps.flatMap((name) => [join(home, "Library", "Application Support", name), join(home, ".config", name)]),
  ];
}

const inside = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Every value of `env` that names a path must sit under `root`; `keys` lists
 * the variables that decide where an app keeps its data.
 */
export function assertEnvUnder(env, keys, root) {
  const problems = [];
  const base = resolve(root);
  for (const key of keys) {
    const value = env[key];
    if (typeof value !== "string" || !value) problems.push(`${key} is not set`);
    else if (!isAbsolute(value)) problems.push(`${key}=${value} is not absolute`);
    else if (!inside(resolve(value), base)) problems.push(`${key}=${value} is outside ${base}`);
  }
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    for (const forbidden of forbiddenPaths()) {
      if (value.split(":").some((part) => part && inside(resolve(part), forbidden))) problems.push(`${key} points into ${forbidden}`);
    }
  }
  if (problems.length) throw new Error(`isolation check failed:\n- ${problems.join("\n- ")}`);
}

/** Paths from `lsof -Fn` output. */
export function parseLsofNames(output) {
  return output.split("\n").filter((line) => line.startsWith("n/")).map((line) => line.slice(1));
}

/** Open files of `pids` that sit in a forbidden directory. Empty means clean. */
export function openForbiddenFiles(pids, { home = homedir(), platform = process.platform, alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}, run = (args) => execFileSync("lsof", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }) } = {}) {
  if (!pids.length) return [];
  let output = "";
  try {
    // Linux can ignore vanished search targets explicitly. Avoid global mount
    // stat calls and their unrelated warnings, such as inaccessible Docker mounts.
    output = run(["-n", "-P", ...(platform === "linux" ? ["-Q", "-b", "-w"] : []), "-Fn", "-p", pids.join(",")]);
  } catch (error) {
    // Older macOS lsof lacks -Q. Accept a missing target only after checking
    // it has exited, with no diagnostics; exit 1 alone also means real errors.
    const found = new Set(typeof error.stdout === "string" ? error.stdout.split("\n").filter((line) => /^p\d+$/u.test(line)).map((line) => Number(line.slice(1))) : []);
    const missing = pids.filter((pid) => !found.has(pid));
    const vanished = platform !== "linux" && error.status === 1 && typeof error.stdout === "string"
      && typeof error.stderr === "string" && !error.stderr.trim() && missing.length > 0 && missing.every((pid) => !alive(pid));
    if (!vanished) throw new Error("Cannot verify comparison isolation: lsof failed.", { cause: error });
    output = error.stdout;
  }
  const forbidden = forbiddenPaths(home);
  return [...new Set(parseLsofNames(output).filter((path) => forbidden.some((root) => inside(path, root))))];
}
