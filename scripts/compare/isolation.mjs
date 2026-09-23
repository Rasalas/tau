// Guards for running both apps without touching the user's own data.
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/** Directories no compared process may open, whatever its environment says. */
export function forbiddenPaths(home = homedir()) {
  return [
    join(home, ".t3"),
    join(home, "Library", "Application Support", "t3code"),
    join(home, "Library", "Application Support", "t3code-dev"),
    join(home, "Library", "Application Support", "T3 Code (Alpha)"),
    join(home, "Library", "Application Support", "T3 Code (Dev)"),
    join(home, "Library", "Application Support", "tau"),
    join(home, "Library", "Application Support", "tau-pi-desktop-prototype"),
    join(home, ".tau"),
    join(home, ".codex"),
    join(home, ".claude"),
    join(home, ".pi"),
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
export function openForbiddenFiles(pids, { home = homedir(), run = (args) => execFileSync("lsof", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }) } = {}) {
  if (!pids.length) return [];
  let output = "";
  try {
    output = run(["-n", "-P", "-Fn", "-p", pids.join(",")]);
  } catch (error) {
    // lsof exits 1 when some pid has already gone; its stdout is still valid.
    output = error.stdout ?? "";
  }
  const forbidden = forbiddenPaths(home);
  return [...new Set(parseLsofNames(output).filter((path) => forbidden.some((root) => inside(path, root))))];
}
