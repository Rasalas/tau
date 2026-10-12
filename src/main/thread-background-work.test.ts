import { describe, expect, it, vi } from "vitest";
import type { ThreadBackgroundCapability } from "./runtime-types.js";
import { ThreadBackgroundWork } from "./thread-background-work.js";

const source = (id: string): ThreadBackgroundCapability => ({ current: () => [{ id, kind: "command", label: id }], stop: vi.fn(async () => undefined), release: vi.fn(), read: () => ({ output: id }) });
describe("a thread's combined background work", () => {
  it("routes operations to the task's owner, including a foreground native command", async () => {
    const native = source("native");
    native.list = () => [...native.current(), { id: "foreground", kind: "command", label: "service" }];
    const managed = source("managed");
    const changed = vi.fn();
    const registry = new ThreadBackgroundWork((id) => id === "one" ? native : undefined, changed);
    registry.provide((id) => id === "one" ? managed : undefined);
    const all = registry.forThread("one")!;
    expect(all.current().map((task) => task.id)).toEqual(["native", "managed"]);
    all.release!("foreground");
    expect(native.release).toHaveBeenCalledWith("foreground");
    expect(managed.release).not.toHaveBeenCalled();
    await all.stop("managed");
    expect(managed.stop).toHaveBeenCalledWith("managed");
    expect(all.read!("native")).toEqual({ output: "native" });
    expect(registry.forThread("two")).toBeUndefined();
    expect(() => all.release!("other")).toThrow("no longer available");
    await all.stop();
    expect(native.stop).toHaveBeenCalledWith();
  });
  it("republishes affected threads when a kit withdraws its work", () => {
    const changed = vi.fn();
    const registry = new ThreadBackgroundWork(() => undefined, changed);
    const remove = registry.provide(() => source("work"));
    registry.changed("one");
    remove();
    expect(registry.forThread("one")).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
