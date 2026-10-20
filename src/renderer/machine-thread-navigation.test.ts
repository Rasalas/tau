import { describe, expect, it, vi } from "vitest";
import type { HostClient } from "../workbench/host-client";
import { ThreadStore } from "../workbench/thread-store";
import { machineThreadPath, openMachineThread } from "./machine-thread-navigation";

describe("opening a thread of another machine", () => {
  it("uses indexed backend ownership and preserves separators in remote ids", async () => {
    const threads = new ThreadStore();
    threads.applyThreadIndex({ projects: [], sessions: [{ id: "rex~saved~thread", path: "tau-thread:machine:rex~saved~thread", title: "Work", projectPath: "/rex/project", projectName: "project", modifiedAt: 1, messageCount: 1, backendKind: "machine", machine: { id: "rex", name: "rex" } }] });
    expect(await machineThreadPath("rex", "saved~thread", undefined, threads)).toBe("tau-thread:machine:rex~saved~thread");
    threads.applyThreadIndex({ projects: [], sessions: [{ id: "rex~saved~thread", path: "/local/thread", title: "Local", projectPath: "/local/project", projectName: "project", modifiedAt: 1, messageCount: 1, backendKind: "pi" }] });
    const client = { invokeHostExtension: vi.fn(async () => ({ machines: [{ id: "rex", status: "connected" }] })) } as unknown as HostClient;
    expect(await machineThreadPath("rex", "saved~thread", client, threads)).toBeUndefined();
    expect(client.invokeHostExtension).not.toHaveBeenCalled();
  });

  it("opens a connected agents thread as a proxy before its index row arrives, and leaves other machines on the legacy path", async () => {
    const invokeHostExtension = vi.fn(async () => ({ machines: [{ id: "rex", status: "connected" }, { id: "old", status: "offline" }] }));
    const client = { invokeHostExtension } as unknown as HostClient;
    expect(await machineThreadPath("rex", "t1", client)).toBe("tau-thread:machine:rex~t1");
    expect(await machineThreadPath("old", "t1", client)).toBeUndefined();
    expect(invokeHostExtension).toHaveBeenCalledWith("tau.environments", "agents");
    invokeHostExtension.mockRejectedValue(new Error("Older host"));
    expect(await machineThreadPath("rex", "t1", client)).toBeUndefined();
  });
});

describe("opening another machine's thread from a thread the user then leaves", () => {
  it("neither switches nor opens a look into it on the thread on screen by then", async () => {
    let answer!: (agents: unknown) => void;
    const client = { invokeHostExtension: vi.fn(() => new Promise((resolve) => { answer = resolve; })) } as unknown as HostClient;
    let scope = "session:A";
    const switchSession = vi.fn(async () => true);
    const lookIn = vi.fn();
    const opening = openMachineThread("old", "t1", { client, scope: () => scope, switchSession, lookIn });
    scope = "session:B";
    answer({ machines: [] });
    await opening;
    expect(lookIn).not.toHaveBeenCalled();
    expect(switchSession).not.toHaveBeenCalled();
    scope = "session:A";
    await openMachineThread("old", "t1", { client: undefined, scope: () => scope, switchSession, lookIn });
    expect(lookIn).toHaveBeenCalledOnce();
  });
});
