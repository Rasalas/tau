import { describe, expect, it, vi } from "vitest";
import type { HostMachine, HostMachineServices, UiRuntimeToolsState } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createEnvironmentsHostExtension } from "./host.js";
import { ENVIRONMENTS_EXTENSION_ID, LOCAL_STATE, LOCAL_UPDATE, MACHINE_TOOLS_STATE, MACHINE_TOOLS_UPDATE } from "./protocol.js";

const state = (): UiRuntimeToolsState => ({ tools: [
  { kinds: ["codex", "codex@work"], label: "Codex", tool: "codex", installed: "1.0.0", latest: "1.1.0", source: "Homebrew", update: "brew upgrade --cask codex" },
  { kinds: ["claude"], label: "Claude", tool: "claude", installed: "1.0.0", latest: "1.0.0", source: "npm", update: "npm update" },
  { kinds: ["custom"], label: "Custom", tool: "custom", installed: "1.0.0", latest: "2.0.0", source: "unknown" },
], log: [] });
function fixture(list: HostMachine[] = []) {
  const call = vi.fn(async () => state());
  const machines: HostMachineServices = { self: { id: "local", name: "mini", version: "1" }, list: () => list, subscribe: () => () => undefined,
    call, request: vi.fn(), watch: () => () => undefined, upload: vi.fn() };
  const runtimeTools = vi.fn(async (_action: "state" | "update", _input?: { kind: string }) => state());
  return { machines, call, runtimeTools };
}

describe("agent tool updates across machines", () => {
  it("uses each receiving host's existing updater once per pending installed program", async () => {
    const f = fixture([{ id: "rex", name: "rex", status: "connected" }]);
    const registry = await activateHostKit(createEnvironmentsHostExtension(), f);
    const answer = await registry.invoke(ENVIRONMENTS_EXTENSION_ID, MACHINE_TOOLS_UPDATE) as Array<{ id: string }>;
    expect(answer.map((entry) => entry.id)).toEqual(["local", "rex"]);
    expect(f.runtimeTools.mock.calls).toEqual([["state"], ["update", { kind: "codex" }]]);
    expect(f.call).toHaveBeenCalledExactlyOnceWith("rex", ENVIRONMENTS_EXTENSION_ID, LOCAL_UPDATE, undefined, { timeoutMs: 120_000 });
  });

  it("skips disconnected/read-only machines and reports older kits without stopping others", async () => {
    const f = fixture([{ id: "sleep", name: "sleep", status: "offline" }, { id: "view", name: "view", status: "connected", readOnly: true }, { id: "old", name: "old", status: "connected" }]);
    f.call.mockRejectedValue(Object.assign(new Error("missing"), { code: "unknown-command" }));
    const registry = await activateHostKit(createEnvironmentsHostExtension(), f);
    const answer = await registry.invoke(ENVIRONMENTS_EXTENSION_ID, MACHINE_TOOLS_UPDATE);
    expect(answer).toMatchObject([{ id: "local", state: { tools: expect.any(Array) } }, { id: "sleep", skipped: "Disconnected" }, { id: "view", skipped: "Read only" }, { id: "old", skipped: "Update Tau on old to manage its agent tools." }]);
    expect(f.call).toHaveBeenCalledOnce();
  });

  it("retries just the named machine while reading everyone else's progress", async () => {
    const f = fixture([{ id: "rex", name: "rex", status: "connected" }, { id: "other", name: "other", status: "connected" }]);
    const registry = await activateHostKit(createEnvironmentsHostExtension(), f);
    f.call.mockRejectedValueOnce(new Error("connection dropped"));
    expect(await registry.invoke(ENVIRONMENTS_EXTENSION_ID, MACHINE_TOOLS_STATE)).toMatchObject([{ id: "local" }, { id: "rex", problem: "connection dropped" }, { id: "other" }]);
    f.call.mockClear();
    await registry.invoke(ENVIRONMENTS_EXTENSION_ID, MACHINE_TOOLS_UPDATE, { machine: "rex" });
    expect(f.runtimeTools).toHaveBeenLastCalledWith("state");
    expect(f.runtimeTools.mock.calls.every(([action]) => action === "state")).toBe(true);
    expect(f.call).toHaveBeenCalledWith("rex", ENVIRONMENTS_EXTENSION_ID, LOCAL_UPDATE, undefined, expect.any(Object));
    expect(f.call).toHaveBeenCalledWith("other", ENVIRONMENTS_EXTENSION_ID, LOCAL_STATE, undefined, expect.any(Object));
  });

  it("leaves busy queues and disabled host policies to the receiving updater", async () => {
    const f = fixture();
    f.runtimeTools.mockResolvedValue({ ...state(), tools: state().tools.map((tool) => ({ ...tool, state: "waiting" as const })) });
    const registry = await activateHostKit(createEnvironmentsHostExtension(), f);
    await registry.invoke(ENVIRONMENTS_EXTENSION_ID, MACHINE_TOOLS_UPDATE);
    expect(f.runtimeTools).toHaveBeenCalledExactlyOnceWith("state");
    f.runtimeTools.mockClear().mockResolvedValue({ ...state(), blocked: "Safe mode runs no updates." });
    expect(await registry.invoke(ENVIRONMENTS_EXTENSION_ID, MACHINE_TOOLS_UPDATE)).toMatchObject([{ skipped: "Safe mode runs no updates." }]);
    expect(f.runtimeTools).toHaveBeenCalledExactlyOnceWith("state");
  });

  it("refuses read-only callers on both aggregate and receiving update commands", async () => {
    const f = fixture();
    const registry = await activateHostKit(createEnvironmentsHostExtension(), f);
    const caller = { kind: "workbench-client" as const, connection: "c", pairedClient: "d", readOnly: true as const };
    for (const command of [MACHINE_TOOLS_UPDATE, LOCAL_UPDATE]) await expect(registry.invoke(ENVIRONMENTS_EXTENSION_ID, command, undefined, caller)).rejects.toThrow(/Read.only/u);
    expect(f.runtimeTools).not.toHaveBeenCalled();
    await expect(registry.invoke(ENVIRONMENTS_EXTENSION_ID, MACHINE_TOOLS_STATE, undefined, caller)).resolves.toMatchObject([{ id: "local" }]);
  });
});
