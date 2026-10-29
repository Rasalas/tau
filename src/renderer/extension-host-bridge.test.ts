import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { HostClient } from "../workbench/host-client";
import { HostUnavailableError as BridgeError } from "./extension-host-bridge";
import { HostUnavailableError, hostExtensionBridge, type ExtensionRegistry, type ThreadMenuLookup } from "./extension-system";

describe("desktop host extension bridge", () => {
  it("preserves the thread menu's exact view of the registry", () => {
    expectTypeOf<ThreadMenuLookup>().toEqualTypeOf<Pick<ExtensionRegistry, "keybindingLabel" | "getCommandsFor">>();
  });


  it("keeps the public error identity and refuses calls without a host", async () => {
    expect(HostUnavailableError).toBe(BridgeError);
    const bridge = hostExtensionBridge(undefined);
    await expect(bridge.invoke("test.kit", "read")).rejects.toBeInstanceOf(HostUnavailableError);
    await expect(bridge.inspect!("/repo")).rejects.toThrow("No machine is connected.");
    expect(bridge.watch).toBeUndefined();
    expect(bridge.resourceUrl).toBeUndefined();
  });

  it("forwards commands, inspection, topic release and optional resource URLs to the active client", async () => {
    const release = vi.fn();
    const invokeHostExtension = vi.fn().mockResolvedValue("answer");
    const inspectExtensions = vi.fn().mockResolvedValue({});
    const watchHostTopic = vi.fn().mockReturnValue(release);
    const client = { invokeHostExtension, inspectExtensions, watchHostTopic, resourceUrl: (path: string) => `https://machine.test/${path}` } as unknown as HostClient;
    const bridge = hostExtensionBridge(client);
    expect(await bridge.invoke("test.kit", "read", { path: "a" })).toBe("answer");
    expect(invokeHostExtension).toHaveBeenCalledWith("test.kit", "read", { path: "a" });
    await bridge.inspect!("/repo");
    expect(inspectExtensions).toHaveBeenCalledWith("/repo");
    bridge.watch!("test.kit", "output")();
    expect(watchHostTopic).toHaveBeenCalledWith("test.kit", "output");
    expect(release).toHaveBeenCalledOnce();
    expect(bridge.resourceUrl!("a")).toBe("https://machine.test/a");
    expect(hostExtensionBridge({ ...client, resourceUrl: undefined }).resourceUrl).toBeUndefined();
  });
});
