import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../../src/workbench/client-storage";
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
});
