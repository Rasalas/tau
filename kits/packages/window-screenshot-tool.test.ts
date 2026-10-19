import { describe, expect, it, vi } from "vitest";
import type { HostExtensionContext, HostMcpTool } from "tau/host-extension";
import { windowScreenshotTools } from "./window-screenshot-tool.js";
import type { WindowScreenshot } from "./screenshot-crop.js";

const image = { data: "cG5n", mimeType: "image/png" as const, width: 240, height: 100 };

function tool(callClient: (command: string, input?: unknown, options?: unknown) => Promise<unknown>) {
  const [made] = windowScreenshotTools({ services: { callClient } } as unknown as HostExtensionContext);
  return (params: unknown) => (made!.execute as unknown as (id: string, params: unknown) => Promise<{ content: Array<Record<string, unknown>>; isError?: boolean; details: Record<string, unknown> }>)("call", params);
}

describe("tau_window_screenshot", () => {
  it("is a read-only tool", () => {
    const [made] = windowScreenshotTools({ services: {} } as unknown as HostExtensionContext) as [HostMcpTool];
    expect(made.name).toBe("tau_window_screenshot");
    expect(made.annotations?.readOnlyHint).toBe(true);
  });

  it("asks the window on the host's machine and returns its picture as an image", async () => {
    const callClient = vi.fn(async (): Promise<WindowScreenshot> => ({ available: true, image, cropped: true, extension: { id: "local.x", found: true, parts: ["region:thread-title"] } }));
    const result = await tool(callClient)({ extension: " local.x ", margin: 20 });
    expect(callClient).toHaveBeenCalledWith("screenshot", { extension: "local.x", margin: 20 }, { window: "host" });
    expect(result.content[1]).toEqual({ type: "image", data: "cG5n", mimeType: "image/png" });
    expect(String(result.content[0]!.text)).toContain("cropped around local.x");
    expect(result.isError).toBeUndefined();
  });

  it("says the region is not visible when the whole window came back for a package", async () => {
    const result = await tool(async () => ({ available: true, image, cropped: false, extension: { id: "local.x", found: false, parts: [] } }))({ extension: "local.x" });
    expect(String(result.content[0]!.text)).toContain("region not visible");
    expect(result.content[1]!.type).toBe("image");
  });

  it("names the whole window when no package was asked for", async () => {
    const callClient = vi.fn(async (): Promise<WindowScreenshot> => ({ available: true, image, cropped: false }));
    const result = await tool(callClient)({});
    expect(callClient).toHaveBeenCalledWith("screenshot", {}, { window: "host" });
    expect(String(result.content[0]!.text)).toContain("the whole window");
  });

  it("answers a clear no-window error for a host without a window", async () => {
    const result = await tool(async () => { throw new Error("This host has no Tau window that runs Packages' half."); })({});
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(String(result.content[0]!.text)).toMatch(/^No window:/u);
  });

  it("passes the window half's refusal on as a no-window error", async () => {
    const result = await tool(async (): Promise<WindowScreenshot> => ({ available: false, reason: "Tau's window is minimized." }))({});
    expect(result).toMatchObject({ isError: true, details: { available: false } });
    expect(String(result.content[0]!.text)).toBe("No window: Tau's window is minimized.");
  });
});
