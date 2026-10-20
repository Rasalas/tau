import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage, setClientStorage } from "../../src/renderer/test-support/kit-harness.js";
import type { PlatformEnvironments, UiEnvironment } from "tau";
import { createUpdateController } from "./update-controller.js";

const disposals: Array<() => void> = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); setClientStorage(undefined); });
const machine = (id: string, version: string): UiEnvironment => ({ id, name: id, local: id === "local", status: "connected", projects: [], threads: [], threadCount: 0,
  update: { version, latest: "2.0.0", phase: version === "2.0.0" ? "current" : "available", channel: "stable", automatic: false, installer: "host", devicesMayInstall: true },
});
function fixture(remoteVersion: string) {
  const storage = createMemoryStorage(); setClientStorage(storage);
  storage.set("tau.updates.v1:local", JSON.stringify({ resumeInterrupted: false, steps: [
    { machine: "rex", label: "rex", kind: "machine", version: "2.0.0", state: "running" },
    { machine: "local", label: "local", kind: "app", version: "2.0.0", state: "pending" },
  ] }));
  const update = vi.fn(async () => ({ ...machine("local", "2.0.0").update!, phase: "installed" as const }));
  const environments = { getSnapshot: () => ({ environments: [machine("rex", remoteVersion), machine("local", "1.0.0")] }), subscribe: () => () => {}, update } as unknown as PlatformEnvironments;
  const controller = createUpdateController(environments); disposals.push(controller.dispose);
  controller.subscribe(() => {});
  return { controller, update };
}

describe("saved update runs", () => {
  it("checks a lost response and resumes only requests that were not sent", async () => {
    const { controller, update } = fixture("2.0.0");
    await vi.waitFor(() => expect(update).toHaveBeenCalledExactlyOnceWith("local", { install: true, resumeInterrupted: false }));
    await vi.waitFor(() => expect(controller.getSnapshot().steps.map((step) => step.state)).toEqual(["done", "running"]));
  });
  it("holds the app restart while a previous machine's update is still uncertain", async () => {
    const { controller, update } = fixture("1.0.0");
    await controller.check(); await controller.review();
    expect(update).not.toHaveBeenCalled();
    expect(controller.getSnapshot().steps[0]).toMatchObject({ uncertain: true });
  });
});

function offlineFixture() {
  const storage = createMemoryStorage(); setClientStorage(storage);
  const machines = [{ ...machine("rex", "1.0.0"), status: "offline" as UiEnvironment["status"] }];
  const listeners = new Set<() => void>();
  const readExtension = vi.fn(async () => ({ tools: [], log: [] }));
  const update = vi.fn(async (id: string, _action: unknown) => {
    const target = machines.find((entry) => entry.id === id)!;
    target.update = { ...target.update!, version: target.update!.latest!, phase: "current" };
    return target.update;
  });
  const environments = { getSnapshot: () => ({ environments: machines }), subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, readExtension, invokeExtension: vi.fn(), update } as unknown as PlatformEnvironments;
  const create = () => { const controller = createUpdateController(environments); disposals.push(controller.dispose); return controller; };
  const controller = create();
  return { controller, create, machines, storage, update, readExtension, emit: () => { for (const listener of listeners) listener(); } };
}

describe("updates when a machine reconnects", () => {
  it("only authorizes an offline update when Update all is started", async () => {
    const f = offlineFixture();
    await f.controller.review();
    expect(f.controller.getSnapshot().steps).toMatchObject([{ state: "skipped", deferUntilOnline: true }]);
    f.machines[0]!.status = "connected"; f.emit();
    await f.controller.check();
    expect(f.update).not.toHaveBeenCalled();
  });
  it("persists a queued update and reads a fresh plan on reconnect, once", async () => {
    const f = offlineFixture();
    await f.controller.review(); await f.controller.run(false);
    expect(f.controller.getSnapshot().steps).toMatchObject([{ state: "queued" }]);
    expect(JSON.parse(f.storage.get("tau.updates.v1:local")!).resumeInterrupted).toBe(false);
    expect(f.readExtension).not.toHaveBeenCalled();
    f.machines[0]!.status = "connected"; f.emit();
    await f.controller.check(); await f.controller.check();
    expect(f.update).toHaveBeenCalledExactlyOnceWith("rex", { install: true, resumeInterrupted: false });
    expect(f.controller.getSnapshot().steps).toMatchObject([{ state: "done" }]);
  });
  it("keeps offline work across a restart and a fresh review without losing its continuation choice", async () => {
    const f = offlineFixture();
    await f.controller.review(); await f.controller.run(false);
    f.controller.dispose();
    const restored = f.create();
    await restored.review();
    expect(restored.getSnapshot().steps).toMatchObject([{ state: "queued" }]);
    f.machines[0]!.status = "connected";
    await restored.check();
    expect(f.update).toHaveBeenCalledExactlyOnceWith("rex", { install: true, resumeInterrupted: false });
  });
  it("cancels a queued update durably", async () => {
    const f = offlineFixture();
    await f.controller.review(); await f.controller.run(true);
    await f.controller.cancelQueued!("rex");
    f.controller.dispose(); const restored = f.create();
    f.machines[0]!.status = "connected";
    await restored.check();
    expect(f.update).not.toHaveBeenCalled();
    expect(restored.getSnapshot().steps).toMatchObject([{ state: "skipped", deferUntilOnline: false, message: "Update cancelled" }]);
  });
  it("also queues a machine that disconnects after review but before dispatch", async () => {
    const f = offlineFixture(); f.machines[0]!.status = "connected";
    await f.controller.review();
    f.machines[0]!.status = "offline";
    await f.controller.run(true);
    expect(f.update).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().steps).toMatchObject([{ state: "queued", deferUntilOnline: true }]);
    f.machines[0]!.status = "connected";
    await f.controller.check();
    expect(f.update).toHaveBeenCalledOnce();
  });
  it.each(["read-only", "owner policy", "refused", "removed"])("does not send a queued update after %s changes", async (change) => {
    const f = offlineFixture();
    await f.controller.review(); await f.controller.run(true);
    f.machines[0]!.status = "connected";
    if (change === "read-only") f.machines[0]!.readOnly = true;
    if (change === "owner policy") f.machines[0]!.update!.devicesMayInstall = false;
    if (change === "refused") f.machines[0]!.status = "refused";
    if (change === "removed") f.machines.length = 0;
    await f.controller.check();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.readExtension).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().steps).toMatchObject([{ state: "skipped", deferUntilOnline: false }]);
  });
  it("coordinates two windows so a reconnect sends only one install", async () => {
    const f = offlineFixture();
    await f.controller.review(); await f.controller.run(true);
    const other = f.create();
    f.machines[0]!.status = "connected";
    await Promise.all([f.controller.check(), other.check()]);
    expect(f.update).toHaveBeenCalledOnce();
    expect(other.getSnapshot().steps).toMatchObject([{ state: "done" }]);
  });
  it("never replays an install whose response was lost", async () => {
    const f = offlineFixture();
    await f.controller.review(); await f.controller.run(true);
    f.update.mockRejectedValue(new Error("Connection lost"));
    f.machines[0]!.status = "connected";
    await f.controller.check(); await f.controller.check();
    f.controller.dispose();
    const restored = f.create(); await restored.check();
    expect(f.update).toHaveBeenCalledOnce();
    expect(restored.getSnapshot().steps).toMatchObject([{ state: "failed", uncertain: true }]);
  });
  it("keeps a failed reconnect review visible and leaves installation to an explicit retry", async () => {
    const f = offlineFixture();
    await f.controller.review(); await f.controller.run(true);
    f.readExtension.mockRejectedValue(new Error("Cannot read tools"));
    f.machines[0]!.status = "connected";
    await f.controller.check(); await f.controller.check();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.readExtension).toHaveBeenCalledOnce();
    expect(f.controller.getSnapshot().steps).toMatchObject([{ state: "failed", message: "Cannot read tools", deferUntilOnline: false }]);
  });
  it("does not dispatch if progress cannot be saved", async () => {
    const f = offlineFixture();
    await f.controller.review(); await f.controller.run(true);
    vi.spyOn(f.storage, "set").mockImplementation(() => { throw new Error("Storage full"); });
    f.machines[0]!.status = "connected";
    await f.controller.check();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.controller.getSnapshot().problem).toContain("could not be saved");
  });
});
