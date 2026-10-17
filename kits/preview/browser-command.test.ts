import { afterEach, expect, it, vi } from "vitest";
import { previewBrowserCommand } from "./headless-surface.js";

afterEach(() => vi.unstubAllEnvs());

it("prefers installed Chrome over a standalone Chromium snapshot", () => {
  vi.stubEnv("TAU_PREVIEW_BROWSER", "");
  const installed: Record<string, string> = { chromium: "/usr/bin/chromium", "google-chrome": "/usr/bin/google-chrome" };
  expect(previewBrowserCommand((name) => installed[name])).toBe("/usr/bin/google-chrome");
});

it("keeps an explicit browser selection ahead of installed Chrome", () => {
  vi.stubEnv("TAU_PREVIEW_BROWSER", "/custom/chromium");
  expect(previewBrowserCommand(() => "/usr/bin/google-chrome")).toBe("/custom/chromium");
});

it("still discovers Chromium when Chrome is not installed", () => {
  vi.stubEnv("TAU_PREVIEW_BROWSER", "");
  expect(previewBrowserCommand((name) => name === "chromium" ? "/usr/bin/chromium" : undefined)).toBe("/usr/bin/chromium");
});
