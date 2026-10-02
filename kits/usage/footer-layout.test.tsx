// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { GitPullRequest } from "lucide-react";
import type { DesktopExtension } from "tau";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { renderCompactApp } from "../../src/renderer/test-support/render-compact-app.js";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { setHostClient, setClientStorage } from "../../src/renderer/test-support/kit-harness.js";
import { workspaceExtension } from "../workspace/desktop.js";
import usageExtension from "./desktop.js";
import { forgetLastState } from "./last-state.js";

const reviews: DesktopExtension = {
  id: "test.reviews", name: "Reviews", activate(plugin) {
    plugin.registerPage({ id: "reviews", label: "Reviews", prominent: true, profiles: ["desktop", "compact"], Icon: GitPullRequest, Component: () => null });
  },
};
const extensions = [workspaceExtension, usageExtension, reviews];

function viewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
  Object.defineProperty(window.screen, "width", { value: width, configurable: true });
  Object.defineProperty(window.screen, "height", { value: height, configurable: true });
}

afterEach(() => { cleanup(); forgetLastState(); setHostClient(undefined); setClientStorage(undefined); viewport(1024, 768); window.history.replaceState(null, "", "/"); });

function client() {
  const workspace = workspaceHostStub();
  return createFakeHostClient({ invokeHostExtension: async (id, command, input) => {
    if (id !== "tau.usage") return workspace(id, command, input);
    const now = Date.now();
    if (command === "limits") return { checkedAt: now, sources: [], accounts: [{ id: "codex:test", runtime: "codex", label: "Codex", checkedAt: now, windows: [{ id: "primary", kind: "session", label: "5-hour", usedPercent: 40, resetsAt: now + 3_600_000 }] }] };
    return { entries: [], rows: [], sources: [], scannedAt: now, totals: { requests: 2, threads: 1, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 120, costUsd: 12.4, subscription: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, apiValueUsd: 0 } } };
  } });
}

describe("Usage in the sidebar foot", () => {
  it.each(["desktop", "ipad"] as const)("keeps Reviews left and price, bars, Settings at the end on %s", async (device) => {
    viewport(1180, 820);
    const host = client();
    const desktop = device === "desktop" ? renderApp(host, { extensions }) : undefined;
    if (!desktop) renderCompactApp(host, extensions);
    const footer = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(".sidebar-footer");
      expect(element).not.toBeNull();
      return element!;
    });
    const price = await within(footer).findByRole("button", { name: /^Usage:.*\$12\.40/u }, { timeout: 5000 });
    const bars = await within(footer).findByRole("button", { name: /^Plan limits/u });
    expect(price.textContent).toBe("$12.40");
    const end = footer.querySelector(".sidebar-footer-end")!;
    expect([...end.querySelectorAll("button")]).toEqual([price, bars, within(footer).getByRole("button", { name: "Settings" })]);
    expect(within(footer).getByRole("button", { name: "Reviews" }).closest(".sidebar-footer-end")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    if (desktop) {
      act(() => desktop.services.preferences.setShowCosts(false));
      await waitFor(() => expect(within(footer).queryByRole("button", { name: /^Usage:/u })).toBeNull());
      expect(within(footer).getByRole("button", { name: /^Plan limits/u })).toBeTruthy();
      act(() => desktop.services.preferences.setShowCosts(true));
    }
    fireEvent.click(await within(footer).findByRole("button", { name: /^Usage:/u }));
    const back = await within(footer).findByRole("button", { name: "Back to thread" });
    expect(within(footer).getAllByRole("button")).toEqual([back]);
    fireEvent.click(back);
    expect(await within(footer).findByRole("button", { name: "Settings" })).toBeTruthy();
  });

  it("keeps the phone's navigation and top strip instead of a sidebar foot", async () => {
    viewport(390, 844);
    renderCompactApp(client(), extensions);
    expect(await screen.findByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: /^Plan limits.*Opens Usage/u }, { timeout: 5000 })).toBeTruthy();
    expect(document.querySelector(".sidebar-footer")).toBeNull();
  });
});
