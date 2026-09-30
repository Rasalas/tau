import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ResetCoordinator } from "./reset-coordinator.js";
import { codexResetCredits } from "./limits.js";
it("preserves uncertain attempts across restart and coalesces one account's overlap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-reset-coordination-"));
  try {
    const coordinator = new ResetCoordinator(directory);
    let reject!: (error: Error) => void;
    const consume = vi.fn((_key: string) => new Promise<never>((_resolve, fail) => { reject = fail; }));
    const first = coordinator.redeem("account", consume);
    expect(coordinator.redeem("account", consume)).toBe(first);
    await vi.waitFor(() => expect(consume).toHaveBeenCalledTimes(1));
    reject(new Error("timeout"));
    await expect(first).rejects.toThrow("timeout");
    const retry = vi.fn().mockResolvedValue("alreadyRedeemed");
    await new ResetCoordinator(directory).redeem("account", retry);
    expect(retry.mock.calls[0]?.[0]).toBe(consume.mock.calls[0]?.[0]);
    await new ResetCoordinator(directory).redeem("account", retry);
    expect(retry.mock.calls[1]?.[0]).not.toBe(retry.mock.calls[0]?.[0]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it("maps the official reset summary separately from quota snapshots", () => {
  expect(codexResetCredits({ rateLimitResetCredits: { availableCount: 2, credits: [{ status: "available", expiresAt: 30 }, { status: "available", expiresAt: 5 }, { status: "consumed", expiresAt: 20 }] } }, 10_000)).toEqual({ availableCount: 2, nextExpiresAt: 30_000 });
  expect(codexResetCredits({ rateLimitResetCredits: { availableCount: -1 } })).toBeUndefined();
});
