import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { GuestShares } from "./store.js";
const blocked = vi.hoisted(() => ({ gate: undefined as Promise<void> | undefined }));
vi.mock("tau/host-extension", async (original) => {
  const api = await original<typeof import("tau/host-extension")>();
  return { ...api, writePersistedJson: async (...args: Parameters<typeof api.writePersistedJson>) => { await blocked.gate; return api.writePersistedJson(...args); } };
});
it("drains retired writes before a replacement store can acknowledge revocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "tau-guest-retirement-"));
  try {
    const file = join(root, "grants.json"); const old = await GuestShares.open(file); await old.setEnabled(true);
    const link = await old.create("one", "One", 8, "watch");
    let finish!: () => void; blocked.gate = new Promise<void>((resolve) => { finish = resolve; });
    const first = old.cache("one", { title: "A", machine: "M", messages: [], tools: [], truncated: false }, link.id);
    const second = old.cache("one", { title: "B", machine: "M", messages: [], tools: [], truncated: false }, link.id);
    let closed = false; const closing = old.close().then(() => { closed = true; });
    await Promise.resolve(); await Promise.resolve(); expect(closed).toBe(false);
    finish(); blocked.gate = undefined; await Promise.all([first, second, closing]);
    const current = await GuestShares.open(file); await current.revoke(link.id); await current.close();
    const restarted = await GuestShares.open(file); expect(restarted.list()).toEqual([]); await restarted.close();
  } finally { blocked.gate = undefined; await rm(root, { recursive: true, force: true }); }
});
