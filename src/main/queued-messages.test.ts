import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QueuedMessages, markWake, type QueuedMessage, type QueuedMessagesView } from "./queued-messages.js";

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
  it("says the run goes on while a message waits or is on its way, not while the queue is held", async () => {
    const { queue, busy, settle, refuseWith } = bench();
    busy.add("t1");
    expect(queue.continues("t1")).toBe(false);
    queue.add("t1", { text: "next", attachments: [] });
    expect(queue.continues("t1")).toBe(true);
    refuseWith("no");
    await settle("t1");
    expect(queue.isHeld("t1")).toBe(true);
    expect(queue.continues("t1")).toBe(false);
  });

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

  describe("wakes", () => {
    const wake = (label: string) => ({ ...markWake(`Check ${label} failed.`, { source: "pull-request", label }), attachments: [] });

    it("delivers a wake with its line in front and keeps its mark in the view and the file", async () => {
      const file = await tempFile();
      const { queue, busy, delivered, published, settle } = bench(file);
      busy.add("t");
      queue.add("t", wake("Woken by PR #42 · check smoke failed"));
      expect(published.get("t")?.messages[0]?.wake).toEqual({ source: "pull-request", label: "Woken by PR #42 · check smoke failed" });
      await queue.flush();
      expect(JSON.parse(await readFile(file, "utf8")).threads.t[0].wake.source).toBe("pull-request");
      await settle("t");
      expect(delivered[0]?.text).toBe("[Tau wake: pull-request] Woken by PR #42 · check smoke failed\n\nCheck Woken by PR #42 · check smoke failed failed.");
      // The delivery writes the file again; the directory goes only once it has.
      await queue.flush();
    });

    it("sends every waiting wake as one message when a wake is at the head", async () => {
      const { queue, busy, delivered, published, settle } = bench();
      busy.add("t");
      queue.add("t", wake("PR #76 · a check failed (test)"));
      queue.add("t", text("mine"));
      queue.add("t", wake("PR #76 · checks finished"));
      await settle("t");
      expect(delivered[0]?.text).toBe("[Tau wake: pull-request] PR #76 · a check failed (test) · checks finished\n\nCheck PR #76 · a check failed (test) failed.\n\nCheck PR #76 · checks finished failed.");
      expect(published.get("t")?.messages.map((message) => message.text)).toEqual(["mine"]);
    });

    it("drops waiting wakes at once and leaves the user's messages in their order", () => {
      const { queue, busy, published } = bench();
      busy.add("t");
      queue.add("t", text("mine"));
      queue.add("t", wake("PR #1"));
      queue.add("t", text("also mine"));
      const dropped = queue.dropWakes("t");
      expect(dropped.map((message) => message.wake?.label)).toEqual(["PR #1"]);
      expect(published.get("t")?.messages.map((message) => message.text)).toEqual(["mine", "also mine"]);
    });

    it("hands the user's messages back without the wakes, so Stop still finds them", () => {
      const { queue, busy } = bench();
      busy.add("t");
      queue.add("t", text("mine"));
      queue.add("t", wake("PR #1"));
      expect(queue.take("t").map((message) => message.text)).toEqual(["mine"]);
      expect(queue.dropWakes("t")).toHaveLength(1);
      expect(queue.list("t")).toEqual([]);
    });

    it("never queues a refused wake again; a refused message of the user's is held", async () => {
      const { queue, published, refuseWith } = bench();
      refuseWith("busy starting");
      queue.add("t", wake("PR #1"));
      await new Promise((resolve) => setImmediate(resolve));
      expect(published.get("t")).toBeUndefined();
      queue.add("t", text("mine"));
      await new Promise((resolve) => setImmediate(resolve));
      expect(published.get("t")).toEqual({ messages: [expect.objectContaining({ text: "mine" })], held: true });
    });

    it("bounds what a kit names a wake", () => {
      const marked = markWake("body", { source: "a-very-long-source-name-that-goes-on-and-on", label: `  two\nlines ${"x".repeat(300)}` });
      expect(marked.wake?.source.length).toBeLessThanOrEqual(32);
      expect(marked.wake?.label.startsWith("two lines")).toBe(true);
      expect(marked.wake!.label.length).toBeLessThanOrEqual(160);
      expect(markWake("plain", undefined)).toEqual({ text: "plain" });
    });
  });
});
