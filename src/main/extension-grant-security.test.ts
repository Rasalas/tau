import { describe, expect, it, vi } from "vitest";
import { createHostMethods, invokeHostMethod, type HostMethodPlatform } from "./host-methods.js";
import { HostJobRunner } from "./host-jobs.js";
import type { PiHost } from "./pi-host.js";
import { ClientCalls } from "./client-calls.js";
import type { HostInvocationPrincipal } from "./host-invocation.js";
import { HOST_ERROR } from "../shared/host-transport.js";
import { NativeExtensionGrants } from "./native-extension-grants.js";
import { WebSocket } from "ws";
import { createSocketHostTransport, type HostSocket } from "../shared/socket-host-transport.js";
import { WindowHost } from "./window-host.js";
import { HostPushLog } from "./host-push-log.js";
import { startSocketHostTransport, type SocketHostTransport } from "./host-transport-socket.js";
import type { HostClientCall } from "../shared/host-transport.js";

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
      confirmExtensionGrant: async () => false,
      loadDesktopExtensions: unsupported, rebuildWorkbench: unsupported,
      workbenchSource: unsupported, relaunchWorkbench: unsupported, installUpdate: unsupported,
      notify: unsupported, setBadge: unsupported, ...extra,
    },
  });
  return { table, grantExtension };
}

describe("extension grant confirmation", () => {
  it.each([true, false])("approves on the remote window's uplink and ignores renderer and stale replies, browser Origin: %s", async (origin) => {
    let server!: SocketHostTransport;
    const received: HostClientCall[] = [];
    const calls = new ClientCalls((connection, call) => { received.push(call); return server.sendCall(connection, call); });
    const { table, grantExtension } = fixture({ confirmExtensionGrant: async () => undefined }, calls);
    server = await startSocketHostTransport({ listen: "127.0.0.1:0", trust: "network", token: "secret", methods: table,
      pushLog: new HostPushLog(), hostVersion: "test", capabilities: [], calls });
    const url = `ws://127.0.0.1:${server.port}`;
    const renderer = createSocketHostTransport(url, "secret", {
      createSocket: (address) => new WebSocket(address, origin ? { origin: `http://127.0.0.1:${server.port}` } : {}) as unknown as HostSocket,
    });
    let answerDialog!: (accepted: boolean) => void;
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => { answerDialog = resolve; }));
    const native = new WindowHost({ userData: "/unused", version: "test", mainDirectory: "/unused", execPath: "/unused", service: null,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      onFatal: vi.fn(), onUrlChanged: vi.fn(), confirmExtensionGrant: confirm });
    native.attach(url, "secret");
    try {
      await native.announceHalves();
      await renderer.request("hello", [{ protocol: 1, windowId: native.windowId, auxiliary: true, nativeGrants: true, windowHalves: ["window"] }]);
      const first = renderer.request("extension-grant", [pkg.id, true]);
      await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
      await renderer.request("client-call-result", [received[0]!.callId, true]);
      expect(grantExtension).not.toHaveBeenCalled();
      answerDialog(false);
      expect((await first).error?.code).toBe(HOST_ERROR.unauthorized);
      const second = renderer.request("extension-grant", [pkg.id, true]);
      await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
      expect(received[1]!.callId).not.toBe(received[0]!.callId);
      expect(received[1]!.input).toEqual(pkg);
      await native.request("client-call-result", [received[0]!.callId, true]);
      expect(grantExtension).not.toHaveBeenCalled();
      answerDialog(true);
      expect((await second).error).toBeUndefined();
      expect(grantExtension).toHaveBeenCalledWith(pkg.id, true);
    } finally { renderer.close?.(); await native.stop(true); calls.dispose(); await server.close(); }
  });

  it("refuses a protocol grant when a native window requires confirmation, even with a forged answer", async () => {
    const { table, grantExtension } = fixture();
    await expect(invokeHostMethod(table, "extension-grant", [pkg.id, true, { confirmed: true }])).rejects.toThrow(/confirmation/iu);
    expect(grantExtension).not.toHaveBeenCalled();
  });

  it("accepts an owner grant when the host has no native window", async () => {
    const channel = new NativeExtensionGrants();
    const { table, grantExtension } = fixture({ confirmExtensionGrant: (entry) => channel.confirm(entry) });
    await invokeHostMethod(table, "extension-grant", [pkg.id, true], { kind: "workbench-client", connection: "owner", local: true });
    expect(grantExtension).toHaveBeenCalledWith(pkg.id, true);
  });

  it("accepts an owner grant when the platform has no native confirmation service", async () => {
    const { table, grantExtension } = fixture({ confirmExtensionGrant: undefined });
    await invokeHostMethod(table, "extension-grant", [pkg.id, true], { kind: "workbench-client", connection: "owner", local: true });
    expect(grantExtension).toHaveBeenCalledWith(pkg.id, true);
  });

  it.each([
    { kind: "workbench-client", connection: "device", pairedClient: "read-only", readOnly: true, local: true },
    { kind: "workbench-client", connection: "device", pairedClient: "write", local: true },
    { kind: "workbench-client", connection: "remote-token" },
    { kind: "host-extension", contextId: "package" },
  ] satisfies HostInvocationPrincipal[])("refuses a headless grant from a non-owner: %j", async (principal) => {
    const channel = new NativeExtensionGrants();
    const { table, grantExtension } = fixture({ confirmExtensionGrant: (entry) => channel.confirm(entry) });
    await expect(invokeHostMethod(table, "extension-grant", [pkg.id, true], principal)).rejects.toMatchObject({ code: HOST_ERROR.forbidden });
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
