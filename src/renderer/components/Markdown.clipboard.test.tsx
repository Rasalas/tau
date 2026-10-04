// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";
import { PlatformProvider } from "../platform-context";
import { createWebPlatform } from "../../web/platform-web";
import { createMemoryStorage } from "../../workbench/client-storage";
import type { Platform } from "../../workbench/platform";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("code copy with desktop clipboard authority", () => {
  it("copies code to the client clipboard even when Chromium clipboard permission is denied", async () => {
    const browserCopy = vi.fn().mockRejectedValue(new DOMException("Write permission denied.", "NotAllowedError"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: browserCopy } });
    const nativeCopy = vi.fn().mockResolvedValue(undefined);
    const platform: Platform = { clipboard: { writeText: nativeCopy }, storage: createMemoryStorage(), importModule: vi.fn(), openExternal: vi.fn() };
    render(<PlatformProvider platform={platform}><Markdown>{"```text\nclipboard repro\n```"}</Markdown></PlatformProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy());
    expect(nativeCopy).toHaveBeenCalledWith("clipboard repro");
    expect(browserCopy).not.toHaveBeenCalled();
  });
  it("retains browser clipboard copying and reports an actual write failure", async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const platform = createWebPlatform({ storage: createMemoryStorage(), openInEditor: vi.fn(), hasLocalFiles: () => false });
    render(<PlatformProvider platform={platform}><Markdown>{"```text\nweb copy\n```"}</Markdown></PlatformProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy failed" })).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith("web copy");
  });
});
