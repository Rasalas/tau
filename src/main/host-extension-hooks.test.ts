import { describe, expect, it } from "vitest";
// Keep exercising the existing entry point as well as the extracted module.
import { HostProjectFactsSet, HostThreadLifecycleSet, type HostSessionFile, type HostThread } from "./host-extensions.js";
import * as hooks from "./host-extension-hooks.js";

const thread = {} as HostThread;

describe("host extension hook collections", () => {
  it("keeps the original constructors at the existing entry point", () => {
    expect(HostProjectFactsSet).toBe(hooks.HostProjectFactsSet);
    expect(HostThreadLifecycleSet).toBe(hooks.HostThreadLifecycleSet);
  });

  it("rolls back every preceding activation in reverse order and preserves the activation error", async () => {
    const set = new HostThreadLifecycleSet();
    const order: string[] = [];
    const failure = new Error("activation failed");
    set.add({ beforeActivate: async () => ({ async commit() {}, async rollback() { order.push("first"); } }) });
    set.add({ beforeActivate: async () => ({ async commit() {}, async rollback() { order.push("second"); throw new Error("rollback failed"); } }) });
    set.add({ beforeActivate: async () => { throw failure; } });
    set.add({ beforeActivate: async () => { order.push("unreached"); } });
    await expect(set.beforeActivate(thread)).rejects.toBe(failure);
    expect(order).toEqual(["second", "first"]);
  });

  it("takes a snapshot for each fan-out and releases hooks for the next step", async () => {
    const set = new HostThreadLifecycleSet();
    const order: string[] = [];
    let release = () => {};
    set.add({ beforeOpen: async () => { order.push("first"); release(); } });
    release = set.add({ beforeOpen: async () => { order.push("second"); } });
    await set.beforeOpen({} as HostSessionFile);
    await set.beforeOpen({} as HostSessionFile);
    expect(order).toEqual(["first", "second", "first"]);
  });

  it("keeps first defined labels, skips empty names, and withdraws project facts", async () => {
    const set = new HostProjectFactsSet();
    const release = set.add({ name: async () => "", label: async () => "", nested: async () => true });
    set.add({ name: async () => "Project", label: async () => "Other" });
    expect(await set.name("/repo")).toBe("Project");
    expect(await set.label("/repo")).toBe("");
    expect(await set.nested("/repo")).toBe(true);
    release();
    expect(await set.label("/repo")).toBe("Other");
    expect(await set.nested("/repo")).toBe(false);
  });
});
