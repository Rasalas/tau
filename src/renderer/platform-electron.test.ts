import { describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../workbench/client-storage";
import type { HostClient } from "../workbench/host-client";
import { createElectronPlatform } from "./platform-electron";

const ports = (client?: Partial<HostClient>) => ({
  ...(client ? { client: client as HostClient } : {}),
  storage: createMemoryStorage(),
  openInEditor: () => undefined,
  hasLocalFiles: () => true,
});

describe("Electron's attention", () => {
  it("writes text through the window client without a browser clipboard request", async () => {
    const copyText = vi.fn(async () => undefined);
    await createElectronPlatform(ports({ copyText })).clipboard.writeText("local clipboard");
    expect(copyText).toHaveBeenCalledWith("local clipboard");
  });
  it("reports unavailable clipboard instead of resolving an absent client write", async () => {
    await expect(createElectronPlatform(ports()).clipboard.writeText("unavailable")).rejects.toThrow("cannot write");
  });
  it("asks the window's own process to notify and to set the badge", async () => {
    const showNotification = vi.fn(async () => "clicked" as const);
    const setBadge = vi.fn(async () => undefined);
    const attention = createElectronPlatform(ports({ showNotification, setBadge })).attention!;
    await expect(attention.notify({ title: "Done", tag: "t1" })).resolves.toBe("clicked");
    attention.setBadge(2);
    expect(showNotification).toHaveBeenCalledWith({ title: "Done", tag: "t1" });
    expect(setBadge).toHaveBeenCalledWith(2);
  });

  it("answers unavailable when the window's process cannot show one", async () => {
    const attention = createElectronPlatform(ports({ showNotification: async () => { throw new Error("unsupported"); } })).attention!;
    await expect(attention.notify({ title: "Done" })).resolves.toBe("unavailable");
  });

  it("has none without a host client to carry the request", () => {
    expect(createElectronPlatform(ports()).attention).toBeUndefined();
  });
});
