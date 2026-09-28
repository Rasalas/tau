import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LimitHistory } from "./limit-history.js";
import { readLimitsAnswer } from "./host.js";
import type { UsageLimitAccount } from "./protocol.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
it("persists real observations, deduplicates cached reads, retains failures and forgets signed-out accounts", async () => {
  const root = await mkdtemp(join(tmpdir(), "tau-quota-")); dirs.push(root);
  const file = join(root, "history.json");
  const history = new LimitHistory(file, readLimitsAnswer);
  const account: UsageLimitAccount = { id: "a", runtime: "codex", label: "Codex", checkedAt: 100_000, windows: [{ id: "w", label: "Week", kind: "weekly", usedPercent: 30 }] };
  const answers = [{ source: "codex", accounts: [account] }];
  await history.load(100_000);
  expect(await history.record(answers, 100_000)).toHaveLength(1);
  expect(await history.record(answers, 200_000)).toHaveLength(1);
  const restored = new LimitHistory(file, readLimitsAnswer);
  await restored.load(200_000);
  expect(restored.latest("codex")).toEqual([account]);
  expect(await restored.record([{ source: "codex" }], 200_000)).toHaveLength(1);
  expect(await restored.record([{ source: "codex", accounts: [{ ...account, unavailable: { reason: "signed-out" }, windows: [] }] }], 200_000)).toEqual([]);
  await restored.record(answers, 200_000);
  expect(await restored.record([], 100_000 + 86_400_001)).toEqual([]);
});
