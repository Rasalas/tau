import { describe, expect, it, vi } from "vitest";
import { createHostMethods, invokeHostMethod, type HostMethodPlatform } from "./host-methods.js";
import { HostJobRunner } from "./host-jobs.js";
import type { PiHost } from "./pi-host.js";
import { ClientCalls } from "./client-calls.js";

const pkg = { id: "acme.pending", name: "Pending", permissions: ["native"], isolation: "in-process" as const, scope: "global" as const, directory: "/packages/pending", desktop: true, host: true };

function fixture(extra: Partial<HostMethodPlatform> = {}, clientCalls?: ClientCalls) {
  const grantExtension = vi.fn(async () => undefined);
  const host = { grantExtension, activeWorkspacePath: () => "/project" } as unknown as PiHost;
  const unsupported = (): never => { throw new Error("not in this test"); };
  const table = createHostMethods({
    clientCalls,
    bootstrap: unsupported, requireHost: async () => host, host: () => host,
    jobs: new HostJobRunner(() => undefined),
    platform: {
      copyText: unsupported, copyImage: unsupported, readImagePreview: unsupported,
      inspectExtensions: async () => ({ versions: { tau: "0.7.41", pi: "1", api: "1.59.0" }, directories: [], packages: [pkg], errors: [], skipped: [] }),
      loadDesktopExtensions: unsupported, rebuildWorkbench: unsupported,
      workbenchSource: unsupported, relaunchWorkbench: unsupported, installUpdate: unsupported,
      notify: unsupported, setBadge: unsupported, ...extra,
    },
  });
  return { table, grantExtension };
}

describe("extension grant confirmation", () => {
  it("refuses a grant when no native confirmation is available, even with a forged answer", async () => {
    const { table, grantExtension } = fixture();
    await expect(invokeHostMethod(table, "extension-grant", [pkg.id, true, { confirmed: true }])).rejects.toThrow(/confirmation/iu);
    expect(grantExtension).not.toHaveBeenCalled();
  });

  it("refuses cancellation and accepts only the main process's positive answer", async () => {
    const confirmExtensionGrant = vi.fn(async () => false);
    const { table, grantExtension } = fixture({ confirmExtensionGrant });
    await expect(invokeHostMethod(table, "extension-grant", [pkg.id, true])).rejects.toThrow(/confirmation/iu);
    expect(grantExtension).not.toHaveBeenCalled();
    confirmExtensionGrant.mockResolvedValue(true);
    await invokeHostMethod(table, "extension-grant", [pkg.id, true]);
    expect(confirmExtensionGrant).toHaveBeenLastCalledWith(pkg);
    expect(grantExtension).toHaveBeenCalledWith(pkg.id, true);
  });

  it("revokes without asking for new privileges", async () => {
    const { table, grantExtension } = fixture();
    await invokeHostMethod(table, "extension-grant", [pkg.id, false]);
    expect(grantExtension).toHaveBeenCalledWith(pkg.id, false);
  });

  it("ignores a forged auxiliary window and its public-protocol approval replies", async () => {
    const send = vi.fn(() => true);
    const calls = new ClientCalls(send);
    calls.attach("forged-window", { local: true, windowId: "same-window", windowHalves: ["window"] });
    const { table, grantExtension } = fixture({}, calls);
    try {
      await invokeHostMethod(table, "client-call-result", ["forged-confirmation", true], { kind: "workbench-client", connection: "forged-window", local: true });
      await expect(invokeHostMethod(table, "extension-grant", [pkg.id, true])).rejects.toThrow(/confirmation/iu);
      expect(send).not.toHaveBeenCalled();
      expect(grantExtension).not.toHaveBeenCalled();
    } finally { calls.dispose(); }
  });

  it("refuses a package whose permissions change while the native dialog is open", async () => {
    const current = { ...pkg, permissions: [...pkg.permissions] };
    const { table, grantExtension } = fixture({
      inspectExtensions: async () => ({ versions: { tau: "0.7.41", pi: "1", api: "1.59.0" }, directories: [], packages: [{ ...current, permissions: [...current.permissions] }], errors: [], skipped: [] }),
      confirmExtensionGrant: async () => { current.permissions.push("process"); return true; },
    });
    await expect(invokeHostMethod(table, "extension-grant", [pkg.id, true])).rejects.toThrow(/changed during confirmation/u);
    expect(grantExtension).not.toHaveBeenCalled();
  });
});
