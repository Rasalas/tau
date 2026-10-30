import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { UiMessage } from "../shared/contracts.js";
import type { HostConversationServices } from "./host-extension-contracts.js";
import type { HostTranscriptCursor } from "../shared/transcript-cursor.js";
import { localTranscriptPage } from "./host-transcript.js";
import { RuntimeConversations } from "./runtime-conversations.js";
import { RuntimeSwitches } from "./runtime-switches.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tau-runtime-conversations-")); roots.push(root);
  const path = join(root, "runtime-segments", "latest.jsonl"); await mkdir(join(root, "runtime-segments")); await writeFile(path, "latest");
  const storePath = join(root, "switches.json"); const switches = new RuntimeSwitches(storePath);
  const inherited: UiMessage[] = Array.from({ length: 90 }, (_, index) => ({ id: `imported-${index}`, role: "user", text: `Imported context ${index}`, timestamp: index }));
  await switches.set("durable", { kind: "pi", cwd: root, sessionPath: path, paths: [join(root, "obsolete.jsonl"), path], history: inherited, offset: 0, contextPending: false });
  const tail: UiMessage[] = Array.from({ length: 90 }, (_, index) => ({ id: `new-${index}`, role: "user", text: `Latest segment ${index}`, timestamp: 100 + index }));
  const read = vi.fn(async (_thread: { sessionId: string; path: string }, cursor?: HostTranscriptCursor) => localTranscriptPage("durable", tail, [], [], true, cursor));
  return { root, path, storePath, switches, inherited, tail, read, services: new RuntimeConversations(switches, read) };
}
async function messages(services: HostConversationServices, version: string) {
  const pages: UiMessage[][] = [];
  let cursor: HostTranscriptCursor | undefined;
  for (;;) {
    const answer = await services.page("durable", version, cursor);
    expect(answer.status).toBe("ok");
    if (answer.status !== "ok") throw new Error(answer.status);
    pages.push(answer.page.messages);
    if (!answer.page.hasMore) break;
    cursor = answer.page.olderCursor;
  }
  return pages.reverse().flat();
}

it("pages inherited history and only the latest Pi segment under one durable id, including after restart", async () => {
  const f = await fixture();
  const [summary] = await f.services.list();
  expect(summary).toMatchObject({ sessionId: "durable", path: f.path });
  expect((await messages(f.services, summary!.version)).map(message => message.id)).toEqual([...f.inherited, ...f.tail].map(message => message.id));
  expect(f.read.mock.calls.every(([thread]) => thread.path === f.path)).toBe(true);
  const restarted = new RuntimeConversations(new RuntimeSwitches(f.storePath), f.read);
  expect(await restarted.list()).toEqual([summary]);
  expect((await messages(restarted, summary!.version)).map(message => message.id)).toEqual([...f.inherited, ...f.tail].map(message => message.id));
});

it("changes the revision when the current segment changes and rejects a mixed export", async () => {
  const f = await fixture(); const [summary] = await f.services.list();
  await writeFile(f.path, "a changed, longer segment");
  expect((await f.services.list())[0]?.version).not.toBe(summary!.version);
  expect(await f.services.page("durable", summary!.version)).toEqual({ status: "changed" });
  const [current] = await f.services.list();
  f.read.mockImplementationOnce(async () => { await writeFile(f.path, "changed again while reading the page"); return localTranscriptPage("durable", f.tail, [], [], true); });
  expect(await f.services.page("durable", current!.version)).toEqual({ status: "changed" });
});

it("does not export a target segment's excluded prefix", async () => {
  const f = await fixture();
  await f.switches.set("durable", { ...f.switches.get("durable")!, offset: 75 });
  const [summary] = await f.services.list();
  expect((await messages(f.services, summary!.version)).map(message => message.id)).toEqual([...f.inherited, ...f.tail.slice(75)].map(message => message.id));
});

it("leaves current external runtimes to their exporters and retains deletion tombstones", async () => {
  const f = await fixture();
  await f.switches.set("durable", { ...f.switches.get("durable")!, kind: "codex", sessionPath: undefined });
  expect(await f.services.list()).toEqual([]);
  expect(await f.services.page("durable", "old")).toEqual({ status: "missing" });
  await f.switches.set("durable", { ...f.switches.get("durable")!, deleted: true });
  expect(await f.services.list()).toMatchObject([{ sessionId: "durable", deleted: true }]);
  expect(f.read).not.toHaveBeenCalled();
});
