import { lstat, mkdir, readdir, readlink, realpath, symlink } from "node:fs/promises";
import { isAbsolute, join, resolve, sep, dirname, basename } from "node:path";
import { expandHome } from "tau/host-extension";
import { codexHome } from "./config.js";

/** An optional auth overlay shares sessions while keeping CLI credentials private. */
export const AUTH_HOME_VARIABLE = "TAU_CODEX_AUTH_HOME";
const SHARED_DIRECTORIES = ["sessions", "archived_sessions", "sqlite", "shell_snapshots", "worktrees", "skills", "plugins", "cache", "logs", "mcp-oauth-locks"];
const PRIVATE = new Set(["auth.json", "models_cache.json", "log", "memories", "tmp"]);

export function codexHomeLayout(env: NodeJS.ProcessEnv) {
  const shared = resolve(codexHome(env));
  const input = env[AUTH_HOME_VARIABLE]?.trim();
  const auth = input ? expandHome(input) : undefined;
  if (auth && !isAbsolute(auth)) throw new Error("The Codex auth home must be an absolute path or start with ~/.");
  return { shared, effective: auth ? resolve(auth) : shared, overlay: Boolean(auth) };
}

async function stat(path: string) {
  try { return await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Never reads, copies, deletes or overwrites auth files or existing runtime data. */
export async function prepareCodexHome(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const layout = codexHomeLayout(env);
  if (!layout.overlay) return env;
  if (layout.effective === layout.shared) throw new Error("The Codex auth home must differ from its shared home.");
  await mkdir(layout.shared, { recursive: true, mode: 0o700 });
  await mkdir(layout.effective, { recursive: true, mode: 0o700 });
  const shared = await realpath(layout.shared);
  const effective = await realpath(layout.effective);
  if (shared === effective || effective.startsWith(shared + sep) || shared.startsWith(effective + sep)) throw new Error("The Codex auth home resolves to its shared home.");
  for (const name of ["auth.json", "models_cache.json"]) {
    if ((await stat(join(effective, name)))?.isSymbolicLink()) throw new Error(`Codex ${name} must be private to its auth home, not a symlink.`);
  }
  for (const name of SHARED_DIRECTORIES) await mkdir(join(shared, name), { recursive: true, mode: 0o700 });
  const names = new Set([...SHARED_DIRECTORIES, ...(await readdir(shared)).filter((name) => !PRIVATE.has(name))]);
  for (const name of names) {
    const target = join(shared, name);
    const link = join(effective, name);
    const existing = await stat(link);
    if (existing) {
      if (!existing.isSymbolicLink() || resolve(effective, await readlink(link)) !== target) throw new Error(`Codex auth home already contains conflicting ${name}; use a fresh auth home.`);
    } else {
      try { await symlink(target, link, (await lstat(target)).isDirectory() ? "dir" : "file"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await stat(link))?.isSymbolicLink() || resolve(effective, await readlink(link)) !== target) throw error;
      }
    }
  }
  // File storage prevents two account overlays from sharing an OS-keychain login.
  return { ...env, CODEX_HOME: effective };
}

export async function canonicalHomePath(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalHomePath(parent), basename(path));
  }
}

export async function canonicalCodexHome(env: NodeJS.ProcessEnv): Promise<string> {
  return canonicalHomePath(codexHomeLayout(env).shared);
}


/** Environment differences may change the provider even when the home matches. */
export function continuationEnvironment(env: NodeJS.ProcessEnv): string {
  const accountOnly = new Set(["CODEX_HOME", AUTH_HOME_VARIABLE, "OPENAI_API_KEY", "CODEX_API_KEY", "ACCESS_TOKEN"]);
  return JSON.stringify(Object.entries(env).filter(([name, value]) => value !== undefined && !accountOnly.has(name)).sort(([a], [b]) => a.localeCompare(b)));
}
