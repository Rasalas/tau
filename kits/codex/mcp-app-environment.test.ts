// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeRefusal } from "./mcp-app-bridge.js";
import { fileBytes, hostContextOf, resourceBytes, saveFile, styleVariables } from "./mcp-app-environment.js";
import { MCP_APP_LIMITS } from "./mcp-app-protocol.js";

afterEach(() => { vi.useRealTimers(); document.documentElement.removeAttribute("style"); });

const input = (overrides: Partial<Parameters<typeof hostContextOf>[0]> = {}): Parameters<typeof hostContextOf>[0] => ({
  scheme: "dark", displayMode: "inline", fullscreenAvailable: false, width: 600, size: () => ({ width: 800, height: 500 }), maxHeight: 2000,
  profile: "desktop", toolId: "call1", toolDefinition: undefined, styles: () => ({ "--font-sans": "x" }), ...overrides,
});

describe("host context", () => {
  it("describes the client as the spec names it", () => {
    const context = hostContextOf(input({ release: "1.2.3", profile: "compact", toolDefinition: { name: "show", inputSchema: { type: "object" } } }));
    expect(context).toMatchObject({
      theme: "dark", displayMode: "inline", availableDisplayModes: ["inline"], containerDimensions: { width: 600, maxHeight: 2000 },
      userAgent: "tau/1.2.3", platform: "mobile", styles: { variables: { "--font-sans": "x" } }, safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      toolInfo: { id: "call1", tool: { name: "show" } },
    });
    expect(context.deviceCapabilities).toEqual({ touch: false, hover: false });
    expect(typeof context.locale).toBe("string");
    expect(typeof context.timeZone).toBe("string");
  });

  it("measures the frame itself in full screen, and offers it only where it works", () => {
    const context = hostContextOf(input({ displayMode: "fullscreen", fullscreenAvailable: true, profile: "web" }));
    expect(context.containerDimensions).toEqual({ width: 800, height: 500 });
    expect(context.availableDisplayModes).toEqual(["inline", "fullscreen"]);
    expect(context.platform).toBe("web");
    expect(context.userAgent).toBe("tau");
    expect(context.toolInfo).toBeUndefined();
  });

  it("falls back to a maximum width before the frame was measured", () => {
    expect(hostContextOf(input({ width: 0 })).containerDimensions).toMatchObject({ maxWidth: expect.any(Number), maxHeight: 2000 });
  });
});

describe("style variables", () => {
  it("always carries the constants and leaves out what the document cannot resolve", () => {
    const variables = styleVariables();
    expect(variables["--font-weight-medium"]).toBe("500");
    expect(variables["--border-radius-full"]).toBe("9999px");
    expect(Object.values(variables).some((value) => value.includes("var("))).toBe(false);
  });

  it("reads fonts and radii from the root's tokens", () => {
    document.documentElement.style.setProperty("--sans", "Test Sans");
    document.documentElement.style.setProperty("--radius-md", "10px");
    const variables = styleVariables();
    expect(variables["--font-sans"]).toBe("Test Sans");
    expect(variables["--border-radius-md"]).toBe("10px");
  });
});

describe("files", () => {
  it("decodes text and base64, and refuses more than 25 MiB", () => {
    expect([...resourceBytes({ text: "hé" })]).toEqual([104, 195, 169]);
    expect([...resourceBytes({ blob: "AAEC" })]).toEqual([0, 1, 2]);
    expect(() => resourceBytes({})).toThrow("no data");
    expect(() => resourceBytes({ blob: "!!!" })).toThrow("not valid");
    expect(() => resourceBytes({ text: "x".repeat(MCP_APP_LIMITS.downloadBytes + 1) })).toThrow(BridgeRefusal);
    expect(() => resourceBytes({ blob: "A".repeat(Math.ceil((MCP_APP_LIMITS.downloadBytes * 4) / 3) + 16) })).toThrow(BridgeRefusal);
  });

  it("reads a linked file through the host", async () => {
    const read = vi.fn(async () => ({ contents: [{ uri: "ui://x", mimeType: "text/csv", text: "a,b" }] }));
    const file = await fileBytes({ name: "x.csv", uri: "ui://x", link: true }, read);
    expect(read).toHaveBeenCalledWith("ui://x");
    expect(file).toMatchObject({ name: "x.csv", mimeType: "text/csv" });
    expect([...file.bytes]).toEqual([...new TextEncoder().encode("a,b")]);
    await expect(fileBytes({ name: "x", uri: "ui://x", link: true }, async () => ({ contents: [] }))).rejects.toThrow("no data");
  });

  it("saves through a temporary link and gives the object URL back after a minute", () => {
    vi.useFakeTimers();
    const create = vi.fn(() => "blob:tau-test");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const clicked: HTMLAnchorElement[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this); });
    saveFile({ name: "r.txt", mimeType: "text/plain", bytes: new Uint8Array([1]) });
    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.download).toBe("r.txt");
    expect(document.querySelector("a[download]")).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revoke).toHaveBeenCalledWith("blob:tau-test");
    click.mockRestore();
  });
});
