import { describe, expect, it } from "vitest";
import { threadFromUrl, threadUrlStep, urlWithThread } from "./thread-url";

const threads = [{ id: "a", path: "/s/a.json" }, { id: "b", path: "/s/b.json" }];

describe("the open thread in the address", () => {
  it("reads and writes ?thread= and keeps everything else", () => {
    expect(threadFromUrl("https://host:8443/?profile=compact&thread=b#x")).toBe("b");
    expect(threadFromUrl("https://host:8443/")).toBeUndefined();
    expect(urlWithThread("https://host:8443/?profile=compact#x", "a")).toBe("/?profile=compact&thread=a#x");
    expect(urlWithThread("https://host:8443/?thread=a", undefined)).toBe("/");
  });

  it("opens the thread a link asks for once the index has it, and gives up on one it does not have", () => {
    expect(threadUrlStep({ wanted: "b", activeThreadId: "", threads: [], firstWrite: true })).toEqual({ kind: "wait" });
    expect(threadUrlStep({ wanted: "b", inUrl: "b", activeThreadId: "a", threads, firstWrite: true })).toEqual({ kind: "open", path: "/s/b.json" });
    expect(threadUrlStep({ wanted: "b", inUrl: "b", activeThreadId: "b", threads, firstWrite: true })).toEqual({ kind: "none" });
    expect(threadUrlStep({ wanted: "gone", inUrl: "gone", activeThreadId: "a", threads, firstWrite: true })).toEqual({ kind: "write", threadId: "a", push: false });
  });

  it("follows the open thread: the first write replaces, later switches add history", () => {
    expect(threadUrlStep({ activeThreadId: "a", threads, firstWrite: true })).toEqual({ kind: "write", threadId: "a", push: false });
    expect(threadUrlStep({ inUrl: "a", activeThreadId: "b", threads, firstWrite: false })).toEqual({ kind: "write", threadId: "b", push: true });
    expect(threadUrlStep({ inUrl: "a", activeThreadId: "a", threads, firstWrite: false })).toEqual({ kind: "none" });
    // A new thread's draft has no id yet; the address keeps the last one.
    expect(threadUrlStep({ inUrl: "a", activeThreadId: "", threads, firstWrite: false })).toEqual({ kind: "none" });
  });
});
