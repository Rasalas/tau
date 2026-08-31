import { describe, expect, it } from "vitest";
import { ThreadRuntimeRegistry } from "./thread-runtimes.js";

interface Fake { name: string }

function registry(maxLive = 3) {
  const disposed: string[] = [];
  const reg = new ThreadRuntimeRegistry<Fake>({
    maxLive,
    dispose: async (record) => { disposed.push(record.sessionId); },
  });
  return { reg, disposed };
}

const record = (sessionId: string) => ({
  sessionId, cwd: `/w/${sessionId}`, runtime: { name: sessionId }, isolation: "in-process" as const,
});

describe("thread runtime registry", () => {
  it("runs work on different threads concurrently, and serialises per thread", async () => {
    const { reg } = registry();
    await reg.adopt(record("a"));
    await reg.adopt(record("b"));

    const order: string[] = [];
    const gate = (ms: number, tag: string) => async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(tag);
      return tag;
    };

    // Two operations on "a" must not overlap; "b" runs alongside them.
    const a1 = reg.run("a", gate(30, "a1"));
    const a2 = reg.run("a", gate(1, "a2"));
    const b1 = reg.run("b", gate(5, "b1"));
    await Promise.all([a1, a2, b1]);

    expect(order.indexOf("a1")).toBeLessThan(order.indexOf("a2"));
    expect(order.indexOf("b1")).toBeLessThan(order.indexOf("a2"));
  });

  it("keeps the thread usable after an operation throws", async () => {
    const { reg } = registry();
    await reg.adopt(record("a"));
    await expect(reg.run("a", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(reg.run("a", async () => "next")).resolves.toBe("next");
  });

  it("releases the least recently used idle runtime beyond the budget", async () => {
    const { reg, disposed } = registry(2);
    await reg.adopt(record("old"));
    await reg.run("old", async () => undefined);
    await reg.adopt(record("mid"));
    await reg.run("mid", async () => undefined);
    await reg.adopt(record("new"));

    expect(disposed).toEqual(["old"]);
    expect(reg.has("old")).toBe(false);
    expect(reg.has("mid")).toBe(true);
    expect(reg.has("new")).toBe(true);
  });

  it("never evicts the thread on screen", async () => {
    const { reg, disposed } = registry(2);
    await reg.adopt(record("viewed"));
    reg.setActive("viewed");
    await reg.adopt(record("second"));
    await reg.run("second", async () => undefined);
    await reg.adopt(record("third"));

    expect(disposed).toEqual(["second"]);
    expect(reg.has("viewed")).toBe(true);
  });

  it("reports which threads are busy", async () => {
    const { reg } = registry();
    await reg.adopt(record("a"));
    const pending = reg.run("a", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 1;
    });
    expect(reg.isBusy("a")).toBe(true);
    await pending;
    expect(reg.isBusy("a")).toBe(false);
    expect(reg.busyCount).toBe(0);
  });

  it("disposes a replaced runtime for the same session", async () => {
    const { reg, disposed } = registry();
    await reg.adopt(record("a"));
    await reg.adopt({ ...record("a"), runtime: { name: "a-replacement" } });
    expect(disposed).toEqual(["a"]);
    expect(reg.get("a")?.runtime.name).toBe("a-replacement");
  });

  it("never evicts a runtime its owner reports as busy", async () => {
    const disposed: string[] = [];
    const busy = new Set(["a"]);
    const reg = new ThreadRuntimeRegistry<Fake>({
      maxLive: 1,
      dispose: async (record) => { disposed.push(record.sessionId); },
      canEvict: (record) => !busy.has(record.sessionId),
    });
    await reg.adopt(record("a"));
    await reg.adopt(record("b"));
    await reg.adopt(record("c"));
    // "a" is over budget and oldest, but still working; "b" goes instead.
    expect(disposed).toEqual(["b"]);
    expect(reg.has("a")).toBe(true);
    expect(reg.has("c")).toBe(true);
  });
});
