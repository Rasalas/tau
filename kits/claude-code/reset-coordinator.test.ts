import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ResetCoordinator } from "./reset-coordinator.js";
it("retains the original grant with an uncertain attempt across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-claude-reset-coordination-"));
  try {
    const coordinator = new ResetCoordinator(directory);
    let originalKey: string | undefined;
    await expect(coordinator.redeem("account", async (key) => {
      originalKey = key;
      await coordinator.bindCredit("account", key, "original_grant");
      throw new Error("uncertain");
    })).rejects.toThrow("uncertain");
    const restarted = new ResetCoordinator(directory);
    expect(await restarted.hasPending("account")).toBe(true);
    await restarted.redeem("account", async (key, pendingCredit) => {
      expect(key).toBe(originalKey);
      expect(pendingCredit).toBe("original_grant");
      return "alreadyRedeemed";
    });
    expect(await restarted.hasPending("account")).toBe(false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
