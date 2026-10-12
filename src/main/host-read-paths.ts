import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { HostCommandError } from "./host-extension-errors.js";
import type { HostExtensionServices } from "./host-extensions.js";

type Workspaces = Pick<HostExtensionServices, "cwd" | "knownWorkspacePath">;
const PATH_FIELD = /(?:paths?|cwd|director(?:y|ies)|dirs?|folders?|roots?|files?|filenames?)$/iu;
const SCOPE_FIELDS = ["workspace", "workspaceId", "cwd"];

const refused = () => Object.assign(new HostCommandError("This device may read only workspace files outside protected home entries and Git internals."), { code: "forbidden" });
const inside = (root: string, path: string) => {
  const child = relative(root, path);
  return !isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`);
};
const gitInternals = (path: string) => path.split(/[\\/]/u).includes(".git");
const protectedPath = (path: string, home: string) => gitInternals(path) || inside(home, path) && relative(home, path).split(sep)[0].startsWith(".");

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw refused();
    const parent = dirname(path);
    if (parent === path) throw refused();
    return resolve(await canonical(parent), relative(parent, path));
  }
}

/** Check before dispatch, including paths carried in nested records and arrays. */
export async function authorizeReadPaths(input: unknown, services: Workspaces, resource: (path: string) => boolean = () => false): Promise<void> {
  const home = await canonical(homedir());
  const known = async (value: string) => {
    try { return await services.knownWorkspacePath(value); } catch { throw refused(); }
  };
  const check = async (value: string, root: string) => {
    // Browser capabilities name virtual resources, never files on disk.
    if (resource(value) && await lstat(value).then(() => false, (error: NodeJS.ErrnoException) => error.code === "ENOENT")) return;
    const actualRoot = await canonical(root);
    if (protectedPath(actualRoot, home)) throw refused();
    // Handlers differ on trimming, separators and home expansion. Check every form.
    const forms = [value, value.trim(), value.replace(/\\/gu, "/"), value.trim().replace(/\\/gu, "/")];
    for (const path of new Set(forms)) {
      if (path.includes("\0") || gitInternals(path) || /^[A-Za-z]:\//u.test(path) && !isAbsolute(path)) throw refused();
      const expanded = path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
      for (const candidate of new Set([path, expanded])) {
        const target = resolve(root, candidate);
        if (!inside(root, target)) throw refused();
        const actual = await canonical(target);
        if (!inside(actualRoot, actual) || protectedPath(actual, home)) throw refused();
      }
    }
  };
  const visit = async (value: unknown, roots: readonly string[], field = "") => {
    if (typeof value === "string") {
      if (PATH_FIELD.test(field) || !field && (isAbsolute(value.trim()) || value.trim().startsWith("~") || /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(value))) {
        const normalized = value.trim().replace(/\\/gu, "/");
        if (isAbsolute(normalized)) {
          if (!isAbsolute(value)) for (const root of roots) await check(value, root);
          const root = roots.find((candidate) => inside(candidate, normalized));
          if (!root) {
            if (resource(value)) { await check(value, roots[0]); return; }
            throw refused();
          }
          await check(value, root);
        } else {
          // An unused workspace field must not redirect validation away from a handler's cwd.
          for (const root of roots) await check(value, root);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) await visit(item, roots, field);
      return;
    }
    if (!value || typeof value !== "object") return;
    const fields = value as Record<string, unknown>;
    const scopes: string[] = [...roots];
    for (const key of SCOPE_FIELDS) {
      const scope = fields[key];
      if (typeof scope === "string" && scope) scopes.push(await known(scope));
    }
    const origins = [...new Set(scopes)];
    for (const [key, entry] of Object.entries(fields)) {
      if (SCOPE_FIELDS.includes(key) && typeof entry === "string") {
        const root = await known(entry);
        await check(root, root);
      } else if (key === "workspaces" && Array.isArray(entry)) {
        for (const workspace of entry) {
          if (typeof workspace === "string") {
            const workspaceRoot = await known(workspace);
            await check(workspaceRoot, workspaceRoot);
          } else await visit(workspace, origins, key);
        }
      } else await visit(entry, origins, key);
    }
  };
  const cwd = services.cwd();
  await check(cwd, cwd);
  await visit(input, [cwd]);
}
