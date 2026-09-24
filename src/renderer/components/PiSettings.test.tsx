// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TauConfig } from "../../shared/contracts";
import { setHostClient } from "../host-client-context";
import { setClientStorage } from "../../workbench/client-storage";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { renderApp } from "../test-support/render-app";
import { workspaceHostStub } from "../test-support/workspace-host-stub";

// The Workbench loads the Settings screen as a chunk of its own. Loaded here, outside the tests,
// its first import on a busy machine does not count against findByRole's wait.
beforeAll(async () => { await import("../settings/SettingsScreen"); });

afterEach(() => {
  cleanup();
  setHostClient(undefined);
  setClientStorage(undefined);
});

function createSettingsClient(initial: TauConfig) {
  let current = initial;
  const calls: Array<{ patch: Partial<TauConfig>; scope: string | undefined }> = [];
  const client = createFakeHostClient({
    platform: "darwin",
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
      detail: { sessionId: "", messages: [], isStreaming: false, activeTools: [] },
      catalog: { models: [], thinkingLevel: "off", thinkingLevels: ["off", "high"], allTools: [], extensionCount: 0 },
      project: { cwd: "/project" },
    }),
    getConfig: async () => current,
    updateConfig: async (patch, scope) => {
      calls.push({ patch, scope });
      current = { ...current, ...patch };
      return current;
    },
    invokeHostExtension: workspaceHostStub({
      listEditors: async () => [],
      getChanges: async () => ({ files: [], added: 0, removed: 0 }),
      getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
      getFileTree: async () => [],
    }),
  });
  return { client, calls };
}

async function openPiPage(): Promise<HTMLElement> {
  const mac = /mac|iphone|ipad/iu.test(navigator.platform);
  fireEvent.keyDown(window, { key: "k", metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true });
  const palette = await screen.findByRole("dialog", { name: "Command palette" });
  const input = within(palette).getByRole("textbox", { name: "Command" });
  fireEvent.change(input, { target: { value: "Open Settings" } });
  fireEvent.keyDown(input, { key: "Enter", bubbles: true, cancelable: true });
  const modal = await screen.findByRole("dialog", { name: "Settings" });
  fireEvent.click(within(modal).getByRole("button", { name: "Pi" }));
  // The page reads Pi's file over the host, so its fields arrive a tick later.
  await within(modal).findByText("Write Pi settings to");
  return modal;
}

describe("Settings → Pi", () => {
  it("shows what Pi's own settings file holds and writes a change back to it", async () => {
    const { client, calls } = createSettingsClient({
      models: { default: "anthropic/claude-sonnet-4", thinkingLevel: "medium" },
      compaction: { enabled: true, reserveTokens: 16384 },
      steeringMode: "one-at-a-time",
      quietStartup: false,
    });
    renderApp(client);
    await screen.findByRole("button", { name: "Send" });
    const modal = await openPiPage();

    // The values Pi's file carries are the values the page shows.
    expect((within(modal).getByRole("textbox", { name: "Model" }) as HTMLInputElement).value)
      .toBe("anthropic/claude-sonnet-4");

    // A segmented choice writes straight through, at global scope by default.
    fireEvent.click(within(within(modal).getByRole("group", { name: "Steering messages" })).getByRole("button", { name: "All at once" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].patch).toEqual({ steeringMode: "all" });
    expect(calls[0].scope).toBe("global");

    // A text field commits when focus leaves it.
    const thinking = within(modal).getByRole("textbox", { name: "Thinking level" });
    fireEvent.change(thinking, { target: { value: "high" } });
    fireEvent.blur(thinking);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].patch).toEqual({ models: { default: "anthropic/claude-sonnet-4", thinkingLevel: "high" } });
  });

  it("writes to the project's own Pi settings when that scope is chosen", async () => {
    const { client, calls } = createSettingsClient({});
    renderApp(client);
    await screen.findByRole("button", { name: "Send" });
    const modal = await openPiPage();

    fireEvent.click(within(modal).getByRole("button", { name: "This project" }));
    fireEvent.click(within(modal).getByRole("switch", { name: "Quiet startup" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].patch).toEqual({ quietStartup: true });
    expect(calls[0].scope).toBe("project");
  });

  it("pins the built-in tool list from the chips, and offers no trust picker in project scope", async () => {
    const { client, calls } = createSettingsClient({ defaultTools: ["read", "bash"] });
    renderApp(client);
    await screen.findByRole("button", { name: "Send" });
    const modal = await openPiPage();

    expect(within(modal).getByRole("button", { name: "read" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(modal).getByRole("button", { name: "edit" }).getAttribute("aria-pressed")).toBe("false");
    expect(within(modal).getByRole("group", { name: "Default project trust" })).toBeTruthy();

    fireEvent.click(within(modal).getByRole("button", { name: "edit" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].patch).toEqual({ defaultTools: ["read", "bash", "edit"] });

    // Pi documents project trust as a global setting, so the project scope hides it.
    fireEvent.click(within(modal).getByRole("button", { name: "This project" }));
    expect(within(modal).queryByRole("group", { name: "Default project trust" })).toBeNull();
  });
});
