import { describe, expect, it } from "vitest";
import { HostClientRegistry } from "./host-clients.js";
import { HostThreadLifecycleSet } from "./host-extensions.js";

describe("HostClientRegistry", () => {
  it("counts clients and tells observers who came and went", () => {
    const counts: number[] = [];
    const registry = new HostClientRegistry((count) => counts.push(count));
    const seen: string[] = [];
    registry.observe({
      attached: (_id, client) => seen.push(`+${client.transport}:${client.profile ?? "none"}`),
      detached: () => seen.push("-"),
    });

    const window = registry.attached({ transport: "electron", profile: "desktop" });
    const browser = registry.attached({ transport: "socket", profile: "web" });
    expect(registry.count()).toBe(2);
    registry.detached(window);
    registry.detached(window);

    expect(seen).toEqual(["+electron:desktop", "+socket:web", "-"]);
    expect(counts).toEqual([1, 2, 1]);
    expect(registry.list().map((client) => client.id)).toEqual([browser]);
  });

  it("replaces the client of a transport key that says hello twice", () => {
    const registry = new HostClientRegistry();
    const first = registry.attached({ transport: "electron", key: "webcontents-1" });
    const second = registry.attached({ transport: "electron", key: "webcontents-1" });
    expect(first).not.toBe(second);
    expect(registry.count()).toBe(1);
    expect(registry.list()[0]?.id).toBe(second);
  });

  it("stops telling an observer that withdrew", () => {
    const registry = new HostClientRegistry();
    const seen: string[] = [];
    const stop = registry.observe({ attached: (id) => seen.push(id) });
    stop();
    registry.attached({ transport: "socket" });
    expect(seen).toEqual([]);
  });
});

describe("HostThreadLifecycleSet", () => {
  it("runs every hook's workspace close and reports the failures together", async () => {
    const set = new HostThreadLifecycleSet();
    const order: string[] = [];
    set.add({ afterWorkspaceClose: async () => { order.push("first"); throw new Error("first failed"); } });
    set.add({ afterWorkspaceClose: async (cwd, reason) => { order.push(`second ${cwd} ${reason}`); } });

    await expect(set.afterWorkspaceClose("/repo", "shutdown")).rejects.toThrow(/Workspace close failed/u);
    expect(order).toEqual(["first", "second /repo shutdown"]);
  });

  it("runs every hook's thread deletion even when one throws", async () => {
    const set = new HostThreadLifecycleSet();
    const seen: string[] = [];
    set.add({ threadDeleted: async () => { throw new Error("no"); } });
    set.add({ threadDeleted: async (sessionId, cwd) => { seen.push(`${sessionId} ${cwd}`); } });

    await expect(set.threadDeleted("gone", "/repo")).rejects.toThrow(/Thread deletion cleanup failed/u);
    expect(seen).toEqual(["gone /repo"]);
  });
});
