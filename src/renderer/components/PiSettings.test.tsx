// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TauConfig, UiModel } from "../../shared/contracts";
import { settingsSearchEntries } from "../settings/settings-search";
import { setHostClient } from "../host-client-context";
import { setClientStorage } from "../../workbench/client-storage";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { runPaletteCommand } from "../test-support/palette";
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

function createSettingsClient(initial: TauConfig, { failing = false, completionModels }: { failing?: boolean; completionModels?: UiModel[] } = {}) {
  let current = initial;
  const calls: Array<{ patch: Partial<TauConfig>; scope: string | undefined }> = [];
  const client = createFakeHostClient({
    platform: "darwin",
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
      detail: { sessionId: "", messages: [], isStreaming: false, activeTools: [] },
      catalog: { models: [], ...(completionModels ? { completionModels } : {}), thinkingLevel: "off", thinkingLevels: ["off", "high"], allTools: [], extensionCount: 0 },
      project: { cwd: "/project" },
    }),
    getConfig: async () => {
      if (failing) throw new Error("settings.json is not valid JSON");
      return current;
    },
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
  return { client, calls, heal: () => { failing = false; } };
}

async function openPiPage(ready = "Write Pi settings to"): Promise<HTMLElement> {
  await runPaletteCommand("Open Settings");
  const modal = await screen.findByRole("dialog", { name: "Settings" });
  // Pi's page sits in the Threads group, folded unless an earlier test opened it: Settings keeps an opened group open.
  const threads = within(modal).getByRole("button", { name: "Threads" });
  if (threads.getAttribute("aria-expanded") !== "true") fireEvent.click(threads);
  fireEvent.click(within(modal).getByRole("button", { name: "Pi" }));
  // The page reads Pi's file over the host, so its fields arrive a tick later.
  await within(modal).findByText(ready);
  return modal;
}

describe("Settings → Pi", () => {
  it("shows what Pi's own settings file holds and writes a change back to it", async () => {
    const { client, calls } = createSettingsClient({
      models: { default: "openai/gpt-5", thinkingLevel: "medium" },
      compaction: { enabled: true, reserveTokens: 16384 },
      steeringMode: "one-at-a-time",
      quietStartup: false,
    });
    renderApp(client);
    await screen.findByRole("button", { name: "Send" });
    const modal = await openPiPage();

    // Without Pi's models on hand the startup model is typed.
    expect((within(modal).getByRole("textbox", { name: "Startup model" }) as HTMLInputElement).value).toBe("openai/gpt-5");
    expect((within(modal).getByRole("combobox", { name: "Startup thinking level" }) as HTMLSelectElement).value).toBe("medium");

    // A choice writes straight through, at global scope by default.
    fireEvent.click(within(within(modal).getByRole("radiogroup", { name: "Steering messages" })).getByRole("radio", { name: "All at once" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].patch).toEqual({ steeringMode: "all" });
    expect(calls[0].scope).toBe("global");

    // The thinking level is one of Pi's levels, not free text.
    fireEvent.change(within(modal).getByRole("combobox", { name: "Startup thinking level" }), { target: { value: "high" } });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].patch).toEqual({ models: { default: "openai/gpt-5", thinkingLevel: "high" } });
  });

  it("refuses a model id with spaces and writes a well-formed one", async () => {
    const { client, calls } = createSettingsClient({});
    renderApp(client);
    await screen.findByRole("button", { name: "Send" });
    const modal = await openPiPage();

    const model = within(modal).getByRole("textbox", { name: "Startup model" });
    fireEvent.change(model, { target: { value: "openai/gpt 5" } });
    fireEvent.blur(model);
    expect(within(modal).getByRole("alert").textContent).toBe("A model id has no spaces.");
    expect(calls).toHaveLength(0);
    fireEvent.change(model, { target: { value: "openai/gpt-5" } });
    fireEvent.blur(model);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].patch).toEqual({ models: { default: "openai/gpt-5" } });
  });

  it("picks the startup model from Pi's models when the host names them", async () => {
    const { client } = createSettingsClient({ models: { default: "openai/gpt-5" } }, { completionModels: [{ provider: "openai", id: "gpt-5", name: "GPT-5" }] });
    renderApp(client);
    await screen.findByRole("button", { name: "Send" });
    const modal = await openPiPage();
    expect(within(modal).getByRole("button", { name: "Startup model: GPT-5" })).toBeTruthy();
    expect(within(modal).queryByRole("textbox", { name: "Startup model" })).toBeNull();
  });

  it("keeps a number out of range from the file and clears one back to Pi's default", async () => {
    const { client, calls } = createSettingsClient({ retry: { enabled: true, maxRetries: 5 } });
    renderApp(client);
    await screen.findByRole("button", { name: "Send" });
    const modal = await openPiPage();

    const retries = within(modal).getByRole("spinbutton", { name: "Max retries" });
    fireEvent.change(retries, { target: { value: "50" } });
    fireEvent.blur(retries);
    expect(within(modal).getByRole("alert").textContent).toBe("Enter a number from 0 to 20.");
    expect(calls).toHaveLength(0);

    fireEvent.change(retries, { target: { value: "" } });
    fireEvent.blur(retries);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].patch).toEqual({ retry: { enabled: true } });
  });

  it("writes to the project's own Pi settings when that scope is chosen", async () => {
    const { client, calls } = createSettingsClient({});
    renderApp(client);
    await screen.findByRole("button", { name: "Send" });
    const modal = await openPiPage();

    fireEvent.click(within(modal).getByRole("radio", { name: "This project" }));
    fireEvent.click(within(modal).getByRole("switch", { name: "Quiet startup" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].patch).toEqual({ quietStartup: true });
    expect(calls[0].scope).toBe("project");
  });

  it("pins the built-in tool list, and keeps project trust global", async () => {
    const { client, calls } = createSettingsClient({ defaultTools: ["read", "bash"] });
    renderApp(client);
    await screen.findByRole("button", { name: "Send" });
    const modal = await openPiPage();

    expect(within(modal).getByRole("checkbox", { name: "read" }).getAttribute("aria-checked")).toBe("true");
    expect(within(modal).getByRole("checkbox", { name: "edit" }).getAttribute("aria-checked")).toBe("false");
    const trust = within(modal).getByRole("radiogroup", { name: "Project trust" });
    expect(trust.closest("[inert]")).toBeNull();

    fireEvent.click(within(modal).getByRole("checkbox", { name: "edit" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].patch).toEqual({ defaultTools: ["read", "bash", "edit"] });

    // Pi documents project trust as a global setting: the project scope leaves it inert and says why.
    fireEvent.click(within(modal).getByRole("radio", { name: "This project" }));
    expect(within(modal).getByRole("radiogroup", { name: "Project trust" }).closest("[inert]")).not.toBeNull();
  });

  it("says so when Pi's file does not read, and reads it again", async () => {
    const { client, heal } = createSettingsClient({ quietStartup: true }, { failing: true });
    renderApp(client);
    await screen.findByRole("button", { name: "Send" });
    const modal = await openPiPage("Pi's settings did not load");
    expect(within(modal).getByText("settings.json is not valid JSON")).toBeTruthy();
    heal();
    fireEvent.click(within(modal).getByRole("button", { name: "Try again" }));
    expect(await within(modal).findByRole("switch", { name: "Quiet startup" })).toBeTruthy();
  });

  it("has every row the search names for it", async () => {
    const { client } = createSettingsClient({});
    renderApp(client);
    await screen.findByRole("button", { name: "Send" });
    const modal = await openPiPage();
    const rows = settingsSearchEntries({ pages: [], extensions: [] }).filter((entry) => entry.page === "pi" && entry.target);
    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) expect(modal.querySelector(`#${row.target}`), row.label).not.toBeNull();
  });
});
