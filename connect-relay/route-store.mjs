import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

export function validateRoutes(routes) {
  if (!routes || typeof routes !== "object" || Array.isArray(routes)) throw new Error("The relay route store is invalid.");
  for (const [id, route] of Object.entries(routes)) {
    if (!/^[a-f0-9-]{36}$/u.test(id) || typeof route?.host !== "string" || typeof route?.client !== "string" || !/^[a-f0-9]{64}$/u.test(route.host) || !/^[a-f0-9]{64}$/u.test(route.client)) throw new Error("The relay route store is invalid.");
  }
  return routes;
}

/** One self-hosted process. Publish a mutation only after its atomic file write succeeds. */
export async function createLocalRouteStore(file) {
  let routes = {};
  if (file) {
    try { routes = validateRoutes(JSON.parse(await readFile(file, "utf8"))); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  let writing = Promise.resolve();
  const change = (update) => {
    const task = writing.then(async () => {
      const next = structuredClone(routes);
      const result = update(next);
      if (file) {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
        await rename(`${file}.tmp`, file);
      }
      routes = next;
      return result;
    });
    writing = task.catch(() => {});
    return task;
  };
  return {
    ready: () => true,
    ensureReady: async () => true,
    snapshot: () => routes,
    add: (id, record, limit) => change((next) => {
      if (Object.keys(next).length >= limit) return false;
      next[id] = record;
      return true;
    }),
    remove: (id) => change((next) => {
      if (!next[id]) return false;
      delete next[id];
      return true;
    }),
    close: () => {},
  };
}
