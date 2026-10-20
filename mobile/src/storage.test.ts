import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../../src/workbench/client-storage";
import { PullRequestCache } from "../../kits/review/pull-request-cache.js";
import { clearHostStorage, hostStorage } from "./storage";

describe("hostStorage", () => {
  it("gives each host its own keys and forgets one host's without the other's", () => {
    const base = createMemoryStorage();
    const a = hostStorage(base, "a");
    const b = hostStorage(base, "b");
    a.set("tau.composer-drafts.v1", "draft for a");
    b.set("tau.composer-drafts.v1", "draft for b");
    a.set("tau.stage.v1:w", "x");
    expect(a.get("tau.composer-drafts.v1")).toBe("draft for a");
    expect(a.keys("tau.stage")).toEqual(["tau.stage.v1:w"]);
    expect(b.keys()).toEqual(["tau.composer-drafts.v1"]);
    clearHostStorage(base, "a");
    expect(a.keys()).toEqual([]);
    expect(b.get("tau.composer-drafts.v1")).toBe("draft for b");
  });

  it("shares the device's own keys across hosts, and keeps them when a host is forgotten", () => {
    const base = createMemoryStorage();
    const a = hostStorage(base, "a");
    const b = hostStorage(base, "b");
    a.set("device:tau.usage.juicebars", "{\"x\":true}");
    expect(b.get("device:tau.usage.juicebars")).toBe("{\"x\":true}");
    expect(b.keys("device:")).toEqual(["device:tau.usage.juicebars"]);
    expect(a.keys()).toEqual([]);
    clearHostStorage(base, "a");
    expect(b.get("device:tau.usage.juicebars")).toBe("{\"x\":true}");
  });

  it("coordinates update work for the same host while another host remains independent", async () => {
    const base = createMemoryStorage();
    const first = hostStorage(base, "a");
    const second = hostStorage(base, "a");
    const other = hostStorage(base, "b");
    const calls: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const one = first.withLock!("updates", async () => { calls.push("a1"); await held; });
    const two = second.withLock!("updates", async () => { calls.push("a2"); });
    await other.withLock!("updates", async () => { calls.push("b"); });
    expect(calls).toEqual(["a1", "b"]);
    release();
    await Promise.all([one, two]);
    expect(calls).toEqual(["a1", "b", "a2"]);
  });
});


it("removes saved request data only for the forgotten machine", async () => {
  const base = createMemoryStorage();
  const a = hostStorage(base, "a");
  const b = hostStorage(base, "b");
  const transport = { invoke: async () => ({ title: "Saved request" }), onEvent: () => () => undefined };
  const input = { url: "https://github.com/acme/app/pull/1" };
  await new PullRequestCache(a).invoke(transport, "pr-view", input);
  await new PullRequestCache(b).invoke(transport, "pr-view", input);
  clearHostStorage(base, "a");
  expect(new PullRequestCache(a, false).peek("pr-view", input)).toBeUndefined();
  expect(new PullRequestCache(b, false).peek("pr-view", input)?.value).toEqual({ title: "Saved request" });
});
