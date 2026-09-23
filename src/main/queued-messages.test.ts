import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QueuedMessages, type QueuedMessage, type QueuedMessagesView } from "./queued-messages.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tau-queue-"));
  dirs.push(dir);
  return join(dir, "queued-messages.json");
}

/** A host with one thread whose run state the test flips by hand. */
function bench(filePath?: string) {
  const busy = new Set<string>();
  const delivered: Array<{ sessionId: string; text: string }> = [];
  const published = new Map<string, QueuedMessagesView | undefined>();
  let refuse: string | undefined;
  const queue = new QueuedMessages({
    busy: (sessionId) => busy.has(sessionId),
    waitForIdle: async () => undefined,
    deliver: async (sessionId, message: QueuedMessage) => {
      if (refuse) throw new Error(refuse);
      delivered.push({ sessionId, text: message.text });
      busy.add(sessionId);
    },
    publish: (sessionId, view) => { published.set(sessionId, view); },
    log: () => undefined,
  }, filePath ? { filePath } : {});
  /** The thread's turn ends; the queue sends its head once the pump has run. */
  const settle = async (sessionId: string) => {
    busy.delete(sessionId);
    queue.settled(sessionId);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { queue, busy, delivered, published, settle, refuseWith: (message: string | undefined) => { refuse = message; } };
}

const text = (message: string) => ({ text: message, attachments: [] });

describe("QueuedMessages", () => {
  it("waits for the running turn, then sends one message per turn, oldest first", async () => {
    const { queue, busy, delivered, published, settle } = bench();
    busy.add("t");
    queue.add("t", text("first"));
    queue.add("t", text("second"));
    expect(delivered).toEqual([]);
    expect(published.get("t")?.messages.map((message) => message.text)).toEqual(["first", "second"]);

    await settle("t");
    expect(delivered.map((entry) => entry.text)).toEqual(["first"]);
    expect(published.get("t")?.messages.map((message) => message.text)).toEqual(["second"]);
    await settle("t");
    expect(delivered.map((entry) => entry.text)).toEqual(["first", "second"]);
    expect(published.get("t")).toBeUndefined();
  });

  it("sends at once to a thread with nothing running", async () => {
    const { queue, delivered } = bench();
    queue.add("idle", text("now"));
    await Promise.resolve();
    expect(delivered).toEqual([{ sessionId: "idle", text: "now" }]);
  });

  it("reorders, takes back and holds what waits", async () => {
    const { queue, busy, delivered, published, settle } = bench();
    busy.add("t");
    const first = queue.add("t", text("first"));
    const second = queue.add("t", text("second"));
    queue.move("t", second.id, 0);
    expect(queue.list("t").map((message) => message.text)).toEqual(["second", "first"]);
    expect(queue.take("t", second.id).map((message) => message.text)).toEqual(["second"]);

    // A stop holds the queue: the turn ends without sending anything.
    queue.hold("t");
    expect(published.get("t")?.held).toBe(true);
    await settle("t");
    expect(delivered).toEqual([]);
    // The next prompt the thread runs lifts the hold, and the queue follows that turn.
    queue.started("t");
    busy.add("t");
    await settle("t");
    expect(delivered.map((entry) => entry.text)).toEqual(["first"]);
    expect(queue.take("t", first.id)).toEqual([]);
  });

  it("puts a refused message back at the head and holds the queue", async () => {
    const { queue, busy, published, settle, refuseWith } = bench();
    busy.add("t");
    queue.add("t", text("refused"));
    queue.add("t", text("behind it"));
    refuseWith("That thread is not open any more.");
    await settle("t");
    expect(queue.list("t").map((message) => message.text)).toEqual(["refused", "behind it"]);
    expect(published.get("t")?.held).toBe(true);
  });

  it("survives a restart and waits for the user unless the thread is continued", async () => {
    const filePath = await tempFile();
    const before = bench(filePath);
    before.busy.add("interrupted");
    before.busy.add("continued");
    before.queue.add("interrupted", { text: "after the turn", attachments: [{ kind: "file", name: "a.txt", mimeType: "text/plain", path: "/a.txt", size: 1 }] });
    before.queue.add("continued", { text: "run the tests", attachments: [], skillDraft: { source: "skill", name: "tdd", visibleText: "/tdd", command: "/skill:tdd" } });
    before.queue.freeze();
    await before.queue.flush();
    expect(JSON.parse(await readFile(filePath, "utf8")).threads.interrupted[0].text).toBe("after the turn");

    const after = bench(filePath);
    after.busy.add("continued");
    await after.queue.restore(["continued"]);
    expect(after.published.get("interrupted")).toMatchObject({ held: true, messages: [{ text: "after the turn", attachments: 1 }] });
    expect(after.published.get("continued")).toMatchObject({ held: false });
    expect(after.queue.list("continued")[0]?.skillDraft?.name).toBe("tdd");

    await after.settle("interrupted");
    expect(after.delivered).toEqual([]);
    await after.settle("continued");
    expect(after.delivered).toEqual([{ sessionId: "continued", text: "run the tests" }]);
    await after.queue.flush();
  });

  it("sends nothing once the host is stopping", async () => {
    const { queue, busy, delivered, settle } = bench();
    busy.add("t");
    queue.add("t", text("later"));
    queue.freeze();
    await settle("t");
    expect(delivered).toEqual([]);
  });
});
