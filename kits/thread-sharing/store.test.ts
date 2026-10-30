import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuestShares } from "./store.js";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function open() {
  const dir = await mkdtemp(join(tmpdir(), "tau-guest-store-")); dirs.push(dir);
  const file = join(dir, "guests.json");
  const store = await GuestShares.open(file); await store.setEnabled(true);
  return { store, file };
}
async function guest(store: GuestShares) {
  const link = await store.create("one", "One", 8, "suggest");
  const token = `taub.${link.id}.${"a".repeat(43)}`;
  await store.claim(link.token, token);
  return { ...link, token };
}
describe("guest grants and moderation", () => {
  it("is disabled by default, replaces concurrent links for the same thread, and bounds live grants", async () => {
    const { store, file } = await open();
    await store.setEnabled(false);
    await expect(store.create("one", "One", 1, "watch")).rejects.toThrow("disabled");
    await store.setEnabled(true);
    await Promise.all([store.create("one", "One", 1, "watch"), store.create("one", "One", 1, "watch")]);
    expect(store.list()).toHaveLength(1);
    for (let i = 2; i <= 20; i++) await store.create(String(i), String(i), 1, "watch");
    await expect(store.create("21", "21", 1, "watch")).rejects.toThrow("too_many_links");
    const restarted = await GuestShares.open(file);
    expect(restarted.list()).toHaveLength(20);
  });
  it("keeps a bounded public snapshot across restart and deletes it on revoke", async () => {
    const { store, file } = await open(); const link = await guest(store);
    await store.cache("one", { title: "Chosen", machine: "Machine", messages: [{ role: "assistant", text: "Public text" }], tools: [], truncated: false }, link.id);
    const restarted = await GuestShares.open(file);
    expect(restarted.cached("one", link.id)?.messages).toEqual([{ role: "assistant", text: "Public text" }]);
    await restarted.revoke(link.id);
    expect((await GuestShares.open(file)).cached("one", link.id)).toBeUndefined();
  });
  it("revocation and pause invalidate admission during async owner moderation", async () => {
    for (const action of ["revoke", "disable"] as const) {
      const { store } = await open(); const link = await guest(store);
      const suggestionId = store.suggest(link.token, "Please send", []);
      let release!: () => void; let entered!: () => void;
      const waiting = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const delivered = vi.fn();
      const pending = store.moderate(link.id, suggestionId, true, async (_id, _suggestion, authorized) => { entered(); await waiting; if (authorized()) delivered(); });
      await started;
      if (action === "revoke") await store.revoke(link.id); else await store.setEnabled(false);
      release(); await pending;
      expect(delivered).not.toHaveBeenCalled();
    }
  });
  it("does not let an old asynchronous projection overwrite a replacement grant", async () => {
    const { store } = await open(); const old = await guest(store);
    const next = await store.create("one", "Replacement", 8, "watch");
    const projection = { title: "Old", machine: "Machine", messages: [{ role: "assistant" as const, text: "Old branch" }], tools: [{ name: "bash", status: "done" as const, output: "Old output" }], truncated: false };
    await expect(store.cache("one", projection, old.id)).rejects.toThrow("ended");
    expect(store.cached("one", next.id)).toBeUndefined();
  });
  it("binds tool output opt-in and the public cache to each grant, across restart and replacement", async () => {
    const { store, file } = await open();
    const projection = { title: "Chosen", machine: "Machine", messages: [], tools: [{ name: "bash", status: "done" as const, output: "Public tool output", id: "PRIVATE", args: { secret: "PRIVATE" } }], truncated: false };
    const off = await store.create("one", "One", 8, "watch");
    await store.cache("one", projection, off.id);
    expect(store.outputAllowed("one", off.id)).toBe(false);
    expect(store.cached("one", off.id)?.tools).toEqual([{ name: "bash", status: "done" }]);
    expect(await readFile(file, "utf8")).not.toContain("Public tool output");
    const on = await store.create("one", "One", 8, "watch", true);
    await store.cache("one", projection, on.id);
    const restarted = await GuestShares.open(file);
    expect(restarted.outputAllowed("one", on.id)).toBe(true);
    expect(restarted.cached("one", on.id)?.tools).toEqual([{ name: "bash", status: "done", output: "Public tool output" }]);
    expect(await readFile(file, "utf8")).not.toContain("PRIVATE");
    await restarted.setEnabled(false);
    expect(restarted.cached("one", on.id)).toBeUndefined();
    expect(() => restarted.outputAllowed("one", on.id)).toThrow("ended");
    await restarted.setEnabled(true);
    const replacement = await restarted.create("one", "One", 8, "watch");
    expect(restarted.outputAllowed("one", replacement.id)).toBe(false);
    await expect(restarted.cache("one", projection, on.id)).rejects.toThrow("ended");
    expect(await readFile(file, "utf8")).not.toContain("Public tool output");
    await restarted.cache("one", projection, replacement.id);
    await restarted.revoke(replacement.id);
    expect((await GuestShares.open(file)).cached("one", replacement.id)).toBeUndefined();
  });
  it("migrates old snapshots with output off and rejects oversized tool snapshots on restart", async () => {
    const { store, file } = await open(); const link = await guest(store);
    await store.cache("one", { title: "One", machine: "Machine", messages: [], tools: [], truncated: false }, link.id);
    const legacy = JSON.parse(await readFile(file, "utf8"));
    delete legacy.grants[0].showToolOutput;
    delete legacy.grants[0].snapshot.tools;
    await writeFile(file, JSON.stringify(legacy));
    const migrated = await GuestShares.open(file);
    expect(migrated.outputAllowed("one", link.id)).toBe(false);
    expect(migrated.cached("one", link.id)?.tools).toEqual([]);
    legacy.grants[0].snapshot.tools = [{ name: "bash", status: "done", output: "x".repeat(32_001) }];
    await writeFile(file, JSON.stringify(legacy));
    expect((await GuestShares.open(file)).list()).toEqual([]);
  });
  it("drops pending images on disable and never blindly retries uncertain delivery", async () => {
    const { store } = await open(); const link = await guest(store);
    const id = store.suggest(link.token, "Question", [{ mimeType: "image/png", data: "private attachment" }]);
    await expect(store.moderate(link.id, id, true, async () => { throw new Error("unknown admission"); })).rejects.toThrow("unknown admission");
    expect(store.list()[0]!.suggestions[0]).toMatchObject({ state: "dismissed", text: "", images: [] });
    await expect(store.moderate(link.id, id, true, async () => undefined)).rejects.toThrow("ended");
    store.suggest(link.token, "Next", [{ mimeType: "image/png", data: "private attachment" }]);
    await store.setEnabled(false); await store.setEnabled(true);
    expect(store.list()[0]!.suggestions).toEqual([]);
  });
});
