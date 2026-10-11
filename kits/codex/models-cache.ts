import { readFile } from "node:fs/promises";
import { join } from "node:path";

const POLL_MS = 100;

/** When Codex last wrote `models_cache.json`, in ms since the epoch; NaN when unreadable. */
async function fetchedAt(codexHome: string): Promise<number> {
  try {
    const stamp = (JSON.parse(await readFile(join(codexHome, "models_cache.json"), "utf8")) as { fetched_at?: unknown }).fetched_at;
    return typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

/**
 * `model/list` serves a cache every Codex client on the machine shares, and the
 * backend tailors the catalog to the client that fetched it, so the first answer
 * can lack tiers. The app-server refreshes the cache at startup: wait up to
 * `timeoutMs` for a write newer than `since`, then list again; otherwise keep the first answer.
 */
export async function listAfterRefresh<T>(input: {
  list: () => Promise<T>;
  codexHome: string;
  since: number;
  timeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<T> {
  const first = await input.list();
  if (input.timeoutMs <= 0) return first;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;
  const deadline = now() + input.timeoutMs;
  while (now() < deadline) {
    await sleep(POLL_MS);
    if (await fetchedAt(input.codexHome) >= input.since) return input.list();
  }
  return first;
}
