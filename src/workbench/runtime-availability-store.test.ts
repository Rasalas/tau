import { describe, expect, it, vi } from "vitest";
import type { HostSnapshot, TauConfig } from "../shared/contracts";
import { RuntimeAvailabilityStore, withDisabledRuntimes } from "./runtime-availability-store";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("RuntimeAvailabilityStore", () => {
  it("asks the host once per project and keeps the same array until the answer changes", async () => {
    const configs: Record<string, TauConfig> = { a: { runtimeEnabled: { codex: false, pi: true } }, b: {} };
    const getConfig = vi.fn(async (workspaceId: string) => configs[workspaceId]!);
    const store = new RuntimeAvailabilityStore({ getConfig });
    const heard = vi.fn();
    store.subscribe(heard);
    expect(store.disabled("a")).toEqual([]);
    store.request("a");
    store.request("a");
    store.request("b");
    store.request(undefined);
    await settle();
    expect(getConfig).toHaveBeenCalledTimes(2);
    expect(store.disabled("a")).toEqual(["codex"]);
    expect(store.disabled("a")).toBe(store.disabled("a"));
    expect(store.disabled("b")).toEqual([]);
    expect(heard).toHaveBeenCalledTimes(1);

    store.refresh();
    await settle();
    expect(heard).toHaveBeenCalledTimes(1);
    configs.a = { runtimeEnabled: { codex: true, cursor: false } };
    store.refresh();
    await settle();
    expect(store.disabled("a")).toEqual(["cursor"]);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("keeps what it knew when the host cannot answer", async () => {
    let fail = false;
    const store = new RuntimeAvailabilityStore({ getConfig: async () => { if (fail) throw new Error("offline"); return { runtimeEnabled: { codex: false } }; } });
    store.request("a");
    await settle();
    fail = true;
    store.refresh();
    await settle();
    expect(store.disabled("a")).toEqual(["codex"]);
  });
});

describe("withDisabledRuntimes", () => {
  const snapshot = { runtimeBackends: [{ kind: "pi", label: "Pi" }, { kind: "codex", label: "Codex" }] } as HostSnapshot;

  it("marks the runtimes a project turned off and nothing else", () => {
    const marked = withDisabledRuntimes(snapshot, ["codex"]);
    expect(marked?.runtimeBackends).toEqual([{ kind: "pi", label: "Pi" }, { kind: "codex", label: "Codex", disabled: true }]);
    expect(marked?.runtimeBackends?.[0]).toBe(snapshot.runtimeBackends?.[0]);
  });

  it("returns the snapshot itself when nothing is off, so nothing re-renders", () => {
    expect(withDisabledRuntimes(snapshot, [])).toBe(snapshot);
    expect(withDisabledRuntimes(undefined, ["codex"])).toBeUndefined();
  });
});
