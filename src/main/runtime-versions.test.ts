import { describe, expect, it, vi } from "vitest";
import type { HostRuntimeBackendProvider } from "./host-extensions.js";
import { RuntimeVersions } from "./runtime-versions.js";

function provider(kind: string, version?: HostRuntimeBackendProvider["version"]): HostRuntimeBackendProvider {
  return { kind, adapter: {} as never, listThreads: async () => [], lookup: async () => undefined, open: async () => { throw new Error("unused"); }, composerCommands: () => [], ...(version ? { version } : {}) };
}

describe("RuntimeVersions", () => {
  it("asks each backend once a day and reports a change once", async () => {
    let now = 0;
    const version = vi.fn(async () => ({ tool: "codex", installed: "0.154.0", latest: "0.155.1" }));
    const onChange = vi.fn();
    const registered = [provider("codex", version), provider("plain")];
    const versions = new RuntimeVersions({ providers: () => registered, onChange, log: () => undefined, now: () => now, env: {} });
    versions.refresh();
    versions.refresh();
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(versions.get("codex")).toEqual({ tool: "codex", installed: "0.154.0", latest: "0.155.1" });
    expect(versions.get("plain")).toBeUndefined();
    expect(version).toHaveBeenCalledTimes(1);
    now += 24 * 60 * 60 * 1000;
    versions.refresh();
    await vi.waitFor(() => expect(version).toHaveBeenCalledTimes(2));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("logs a failing backend and keeps nothing for it", async () => {
    const log = vi.fn();
    const versions = new RuntimeVersions({ providers: () => [provider("broken", async () => { throw new Error("no binary"); })], onChange: () => undefined, log });
    versions.refresh();
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith("runtime-version.failed", "broken: no binary"));
    expect(versions.get("broken")).toBeUndefined();
  });

  it("asks a kind registered anew at once, as after its instance was edited", async () => {
    const first = vi.fn(async () => ({ tool: "codex", installed: "0.154.0" }));
    const second = vi.fn(async () => ({ tool: "codex", installed: "0.160.0" }));
    let registered = [provider("codex@work", first)];
    const versions = new RuntimeVersions({ providers: () => registered, onChange: () => undefined, log: () => undefined, now: () => 0 });
    versions.refresh();
    await vi.waitFor(() => expect(versions.get("codex@work")?.installed).toBe("0.154.0"));
    registered = [provider("codex@work", second)];
    versions.refresh();
    await vi.waitFor(() => expect(versions.get("codex@work")?.installed).toBe("0.160.0"));
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("keeps no newer release while TAU_NO_RUNTIME_UPDATES=1, so no client offers an update", async () => {
    const version = vi.fn(async () => ({ tool: "claude", installed: "2.1.281", latest: "2.1.282", updateCommand: "claude update" }));
    const versions = new RuntimeVersions({ providers: () => [provider("claude-code", version)], onChange: () => undefined, log: () => undefined, env: { TAU_NO_RUNTIME_UPDATES: "1" } });
    versions.refresh();
    await vi.waitFor(() => expect(versions.get("claude-code")).toEqual({ tool: "claude", installed: "2.1.281", updateCommand: "claude update" }));
  });
});
