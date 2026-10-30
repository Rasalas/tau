import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { HostConversationServices, HostConversationSummary, HostTranscriptCursor } from "tau/host-extension";
import { ConversationThreadIndex } from "./conversation-threads.js";
import { PersistentMessageIndex } from "./persistent-index.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tau-search-conversation-")); roots.push(root);
  let listed: HostConversationSummary[] = [{ sessionId: "same-id", cwd: root, path: "/latest/pi.jsonl", modifiedAt: 20, version: "v1" }];
  const page = vi.fn<HostConversationServices["page"]>(async (_id, version, cursor) => version !== "v1" ? { status: "changed" } : { status: "ok", page: {
    sessionId: "same-id", hasMore: cursor === undefined,
    ...(cursor === undefined ? { olderCursor: "inherited" as HostTranscriptCursor } : {}),
    messages: cursor === undefined ? [{ id: "new", role: "assistant", text: "x".repeat(100_000) + " latest quasar", timestamp: 2 }]
      : [{ id: "imported", role: "user", text: "imported nebula", timestamp: 1 }],
  } });
  const services: HostConversationServices = { list: async () => listed, page };
  const persistent = new PersistentMessageIndex(root);
  return { services, page, persistent, setList: (value: typeof listed) => { listed = value; } };
}
async function matches(index: ConversationThreadIndex, query: string) {
  const result = [];
  for await (const match of index.search([query])) result.push(match);
  return result;
}

it("indexes every canonical page and long message atomically, and reuses unchanged exports after restart", async () => {
  const f = await fixture(); const index = new ConversationThreadIndex(f.services, { persistent: f.persistent });
  await index.sync();
  expect(index.suppresses("same-id")).toBe(true);
  expect(await matches(index, "nebula")).toMatchObject([{ sessionId: "same-id", path: "/latest/pi.jsonl" }]);
  expect(await matches(index, "quasar")).toMatchObject([{ sessionId: "same-id" }]);
  f.page.mockClear();
  const restarted = new ConversationThreadIndex(f.services, { persistent: f.persistent }); await restarted.sync();
  expect(f.page).not.toHaveBeenCalled();
  expect(await matches(restarted, "quasar")).toHaveLength(1);
});

it("retains old source aliases until the canonical replacement is usable", async () => {
  const f = await fixture(); const index = new ConversationThreadIndex(f.services, { persistent: f.persistent });
  await index.sync();
  f.setList([{ sessionId: "same-id", cwd: "/repo", path: "/newer/pi.jsonl", modifiedAt: 30, version: "v2" }]);
  await index.sync();
  expect(index.truncated).toBe(true);
  expect(index.suppresses("same-id")).toBe(false);
  expect(await matches(index, "nebula")).toEqual([]);
});

it("restores existing sources for an external-current thread and suppresses retained tombstones", async () => {
  const f = await fixture(); const index = new ConversationThreadIndex(f.services, { persistent: f.persistent }); await index.sync();
  f.setList([]); await index.sync();
  expect(index.suppresses("same-id")).toBe(false);
  expect(await f.persistent.catalog()).toEqual([]);
  f.setList([{ sessionId: "same-id", cwd: "/repo", path: "", modifiedAt: 30, version: "deleted", deleted: true }]); await index.sync();
  expect(index.suppresses("same-id")).toBe(true);
});
