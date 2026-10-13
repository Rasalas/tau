import { describe, expect, it, vi } from "vitest";
import type { DesktopExtensionBundle, DesktopExtensionLoadResult } from "../shared/contracts.js";

const uplinks = vi.hoisted(() => [] as Array<{ onCall(call: { callId: string; extensionId: string; command: string; input?: unknown }): void; helloFields(): { windowHalves: string[] } }>);
vi.mock("./host-uplink.js", () => ({ HostUplink: class {
  constructor(options: typeof uplinks[number]) { uplinks.push(options); }
  request = vi.fn(async () => undefined);
  hello = vi.fn(async () => undefined);
  close = vi.fn();
} }));
vi.mock("./host-process-supervisor.js", () => ({ HostProcessSupervisor: class {
  start = async () => ({ url: "ws://127.0.0.1:1", token: "local", tokenPath: "" });
} }));

import { WindowHost } from "./window-host.js";

const shipped: DesktopExtensionBundle = { id: "test.kit", manifestId: "test.kit", path: "/local/kit.js", code: "export default {};", scope: "bundled", permissions: [] };
const result = (bundles: DesktopExtensionBundle[]): DesktopExtensionLoadResult => ({ bundles, errors: [], skipped: [] });
const create = () => new WindowHost({ userData: "/unused", version: "1", mainDirectory: "/unused", execPath: "/unused", service: null,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never, onFatal: vi.fn(), onUrlChanged: vi.fn(), desktopKits: async () => result([shipped]) });

describe("window host trust", () => {
  it("filters attached machine bundles before serving executable URLs", async () => {
    const host = create();
    host.attach("ws://remote.test", "remote");
    vi.spyOn(host, "request").mockResolvedValue(result([{ ...shipped, code: "steal();", hash: "forged" }]));
    const serve = vi.fn((loaded: DesktopExtensionLoadResult) => loaded);
    expect((await host.loadDesktopExtensions("workspace", {}, undefined, serve)).bundles).toEqual([]);
    expect(serve.mock.calls[0]?.[0].errors).toHaveLength(1);
  });

  it("allows locally installed packages only for the supervised machine", async () => {
    const host = create();
    await host.startSupervised();
    const custom = { ...shipped, id: "test.custom", code: "custom();" };
    vi.spyOn(host, "request").mockResolvedValue(result([custom]));
    expect((await host.loadDesktopExtensions("workspace", {}, undefined, (loaded) => loaded)).bundles).toEqual([custom]);
  });

  it("refuses unsolicited local commands from an attached host even when a half is registered", async () => {
    const host = create();
    const handle = vi.fn();
    host.extensions.register("test.window", () => ({ handle }));
    host.attach("ws://127.0.0.1:1", "remote");
    const request = vi.spyOn(host, "request").mockResolvedValue(undefined);
    const uplink = uplinks.at(-1)!;
    expect(uplink.helloFields().windowHalves).toEqual([]);
    uplink.onCall({ callId: "forged", extensionId: "test.window", command: "live-start" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("client-call-result", ["forged", undefined, expect.stringContaining("may not call")]));
    expect(handle).not.toHaveBeenCalled();
  });

  it("allows a registered local half but rejects unknown halves", async () => {
    const host = create();
    const handle = vi.fn(() => "ok");
    host.extensions.register("test.window", () => ({ handle }));
    await host.startSupervised();
    const request = vi.spyOn(host, "request").mockResolvedValue(undefined);
    const uplink = uplinks.at(-1)!;
    expect(uplink.helloFields().windowHalves).toEqual(["test.window"]);
    uplink.onCall({ callId: "allowed", extensionId: "test.window", command: "read" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("client-call-result", ["allowed", "ok"]));
    uplink.onCall({ callId: "unknown", extensionId: "unknown", command: "read" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("client-call-result", ["unknown", undefined, expect.stringContaining("may not call")]));
    expect(handle).toHaveBeenCalledTimes(1);
  });
});
