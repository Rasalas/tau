// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../workbench/client-storage";
import { createWebPlatform } from "./platform-web";

const ports = () => ({ storage: createMemoryStorage(), openInEditor: () => undefined, hasLocalFiles: () => true });

afterEach(() => { vi.unstubAllGlobals(); });

describe("what a browser tab can offer the workbench", () => {
  it("writes to the page's own clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await createWebPlatform(ports()).clipboard.writeText("copied");
    expect(writeText).toHaveBeenCalledWith("copied");
  });

  it("says so when the browser will not let it copy, instead of copying nothing", async () => {
    vi.stubGlobal("navigator", {});
    await expect(createWebPlatform(ports()).clipboard.writeText("copied")).rejects.toThrow(/clipboard/u);
  });

  it("has no editor and no image clipboard, even on a host that is this machine", () => {
    const platform = createWebPlatform(ports());
    expect(platform.files).toBeUndefined();
    expect(platform.clipboard.writeImage).toBeUndefined();
  });

  it("stores through the client storage it was booted with", () => {
    const storage = createMemoryStorage();
    const platform = createWebPlatform({ ...ports(), storage });
    platform.storage.set("k", "v");
    expect(storage.get("k")).toBe("v");
  });
});
