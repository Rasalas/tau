import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { OutsideUsageCache, type OutsideRoot } from "./outside-cache.js";
import { openSqlite } from "./opencode-store.js";

/**
 * Against a database a real OpenCode 2 wrote, skipped unless `TAU_OPENCODE2_DATA`
 * names its data folder (the one holding `opencode.db`). The database is copied
 * first; the run never touches the original. `TAU_OPENCODE2_EXPECT` is the
 * `<total tokens>` the sessions should sum to.
 */
const DATA = process.env.TAU_OPENCODE2_DATA;
const EXPECT = process.env.TAU_OPENCODE2_EXPECT;

const roots: string[] = [];
afterAll(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe.skipIf(!DATA)("the Usage cache against a real OpenCode 2 database", () => {
  it("counts its responses under the folder they ran in", async () => {
    if (!await openSqlite()) return;
    const root = await mkdtemp(join(tmpdir(), "tau-usage-oc2-"));
    roots.push(root);
    const copy = join(root, "data");
    await mkdir(copy, { recursive: true });
    for (const name of await readdir(DATA!)) if (/^opencode\.db(-wal|-shm)?$/u.test(name)) await copyFile(join(DATA!, name), join(copy, name));
    const cache = new OutsideUsageCache(join(root, "outside-usage.json"), Date.now);
    await cache.refresh([{ format: "opencode", backend: "opencode", label: "OpenCode", path: copy } satisfies OutsideRoot]);
    const sessions = cache.snapshot().units.flatMap(({ unit }) => unit.sessions);
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) expect(session.cwd).not.toBe("");
    const total = sessions.flatMap((session) => session.buckets).reduce((sum, bucket) => sum + bucket.total, 0);
    console.log(`OpenCode 2: ${sessions.length} session(s), ${total} tokens, cwd ${sessions.map((session) => session.cwd).join(", ")}`);
    if (EXPECT) expect(total).toBe(Number(EXPECT));
  });
});
