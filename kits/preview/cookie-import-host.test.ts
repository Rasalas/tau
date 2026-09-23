import { describe, expect, it } from "vitest";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createPreviewHostExtension } from "./host.js";
import { CookieImportHost, type CookieImportWindow } from "./cookie-import-host.js";
import { PREVIEW_HOST_EXTENSION_ID } from "./protocol.js";

const target = (reloaded: string[] = []) => ({
  profiles: async () => ({ profiles: ["default", "work"], active: "default" }),
  partition: (name: string) => name === "default" ? "persist:tau-preview" : `persist:tau-preview-${name}`,
  reload: async (name: string) => { reloaded.push(name); return name === "default"; },
});

describe("the host's side of cookie import", () => {
  it("names the partition, runs in-process imports directly and reloads the page in that profile", async () => {
    const calls: Array<{ command: string; input: unknown }> = [];
    const window: CookieImportWindow = {
      inProcess: true,
      call: async (command, input) => { calls.push({ command, input }); return { imported: 3, skipped: 0, skippedSites: [] }; },
    };
    const reloaded: string[] = [];
    const host = new CookieImportHost(window, target(reloaded));
    await expect(host.import({ source: "chrome", profile: "Default", sites: ["github.com"], into: "Default" })).resolves.toEqual({ imported: 3, skipped: 0, skippedSites: [], profile: "default", reloaded: true });
    expect(calls).toEqual([{ command: "cookie-import", input: { source: "chrome", profile: "Default", sites: ["github.com"], partition: "persist:tau-preview" } }]);
    expect(reloaded).toEqual(["default"]);
  });

  it("refuses a Preview profile that does not exist before the window is asked anything", async () => {
    const calls: string[] = [];
    const host = new CookieImportHost({ inProcess: true, call: async (command) => { calls.push(command); return {}; } }, target());
    await expect(host.import({ source: "chrome", profile: "Default", sites: ["a.com"], into: "ghost" })).rejects.toThrow(/^\[unknown-profile\]/u);
    expect(calls).toEqual([]);
  });

  it("waits for a window half's report, which may come after a client call would have given up", async () => {
    const calls: Array<{ command: string; input: Record<string, unknown> }> = [];
    const window: CookieImportWindow = {
      inProcess: false,
      call: async (command, input) => { calls.push({ command, input: input as Record<string, unknown> }); return { started: true }; },
    };
    const host = new CookieImportHost(window, target());
    const pending = host.import({ source: "firefox", profile: "p", sites: ["a.com"], into: "work" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls[0]?.command).toBe("cookie-import-start");
    expect(calls[0]?.input.partition).toBe("persist:tau-preview-work");
    host.settle({ job: "someone-else", result: { imported: 9 } });
    host.settle({ job: calls[0]?.input.job, result: { imported: 1, skipped: 0, skippedSites: [] } });
    await expect(pending).resolves.toEqual({ imported: 1, skipped: 0, skippedSites: [], profile: "work", reloaded: false });
  });

  it("hands a window half's failure on with its reason", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const host = new CookieImportHost({ inProcess: false, call: async (_command, input) => { calls.push(input as Record<string, unknown>); return { started: true }; } }, target());
    const pending = host.import({ source: "chrome", profile: "Default", sites: ["a.com"], into: "default" });
    await new Promise((resolve) => setImmediate(resolve));
    host.settle({ job: calls[0]?.job, error: "[keychain-denied] The keychain did not hand out the key." });
    await expect(pending).rejects.toThrow(/^\[keychain-denied\]/u);
  });

  it("says a desktop app is needed when no window half answers", async () => {
    const host = new CookieImportHost({ inProcess: false, call: () => Promise.reject(new Error("No client answered tau.preview/cookie-sources within 30000ms.")) }, target());
    await expect(host.sources()).rejects.toThrow(/^\[no-window\]/u);
  });

  it("fails every waiting import when Preview stops", async () => {
    const host = new CookieImportHost({ inProcess: false, call: async () => ({ started: true }) }, target());
    const pending = host.import({ source: "chrome", profile: "Default", sites: ["a.com"], into: "default" });
    await new Promise((resolve) => setImmediate(resolve));
    host.dispose();
    await expect(pending).rejects.toThrow(/stopped/u);
  });
});

describe("Preview Kit's import commands", () => {
  it("route through the window half and the settle command", async () => {
    const calls: Array<{ command: string; input: Record<string, unknown> }> = [];
    let registry: Awaited<ReturnType<typeof activateHostKit>> | undefined;
    const window = (): CookieImportWindow => ({
      inProcess: false,
      call: async (command, input) => {
        calls.push({ command, input: (input ?? {}) as Record<string, unknown> });
        if (command === "cookie-sources") return [{ id: "firefox", name: "Firefox", engine: "firefox", profiles: [] }];
        // The window half reports through the kit's own host command, as `invokeHost` does.
        if (command === "cookie-import-start") setImmediate(() => void registry!.invoke(PREVIEW_HOST_EXTENSION_ID, "cookie-import-settled", { job: (input as { job: string }).job, result: { imported: 2, skipped: 0, skippedSites: [] } }));
        return { started: true };
      },
    });
    registry = await activateHostKit(createPreviewHostExtension(async () => undefined, window), {
      stateDir: "",
      findCommand: () => undefined,
      registerTurnObserver: () => () => undefined,
      registerRuntimeExtension: () => () => undefined,
    });
    await expect(registry.invoke(PREVIEW_HOST_EXTENSION_ID, "import-sources", undefined)).resolves.toEqual([{ id: "firefox", name: "Firefox", engine: "firefox", profiles: [] }]);
    await expect(registry.invoke(PREVIEW_HOST_EXTENSION_ID, "import-cookies", { source: "firefox", profile: "p", sites: ["a.com"], into: "default" }))
      .resolves.toEqual({ imported: 2, skipped: 0, skippedSites: [], profile: "default", reloaded: false });
    expect(calls.map(({ command }) => command)).toEqual(["cookie-sources", "cookie-import-start"]);
  });
});
