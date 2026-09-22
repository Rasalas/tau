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
    const versions = new RuntimeVersions({ providers: () => [provider("codex", version), provider("plain")], onChange, log: () => undefined, now: () => now });
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
});
