import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listAfterRefresh } from "./models-cache.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const home = async () => { const path = await mkdtemp(join(tmpdir(), "tau-codex-cache-")); directories.push(path); return path; };
const stamp = (folder: string, at: number) => writeFile(join(folder, "models_cache.json"), JSON.stringify({ fetched_at: new Date(at).toISOString(), models: [] }));

describe("the model catalog behind a fresh cache", () => {
  it("lists again once Codex writes the cache after the process started", async () => {
    const codexHome = await home();
    const since = Date.UTC(2026, 9, 11, 12);
    await stamp(codexHome, since - 60_000);
    const lists: string[] = [];
    const list = async () => { lists.push(String(lists.length + 1)); return `catalog ${lists.length}`; };
    // The refresh lands during the first wait.
    const sleep = async () => { await stamp(codexHome, since + 500); };
    await expect(listAfterRefresh({ list, codexHome, since, timeoutMs: 3_000, sleep, now: () => since })).resolves.toBe("catalog 2");
  });

  it("keeps the first answer when no refresh arrives in time or the cache is unreadable", async () => {
    const codexHome = await home();
    const since = Date.UTC(2026, 9, 11, 12);
    let clock = since;
    const sleep = async (ms: number) => { clock += ms; };
    let calls = 0;
    const list = async () => `catalog ${++calls}`;
    await expect(listAfterRefresh({ list, codexHome, since, timeoutMs: 3_000, sleep, now: () => clock })).resolves.toBe("catalog 1");
    await writeFile(join(codexHome, "models_cache.json"), "not json");
    await expect(listAfterRefresh({ list, codexHome, since, timeoutMs: 3_000, sleep, now: () => clock })).resolves.toBe("catalog 2");
    expect(calls).toBe(2);
  });

  it("does not wait when the wait is off", async () => {
    let calls = 0;
    const sleep = async () => { throw new Error("waited"); };
    await expect(listAfterRefresh({ list: async () => ++calls, codexHome: "/nowhere", since: 0, timeoutMs: 0, sleep })).resolves.toBe(1);
  });
});
