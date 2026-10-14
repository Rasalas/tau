// @vitest-environment jsdom
import { cleanup, fireEvent, render as renderView, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import { renderKitSettingsPage } from "../../src/renderer/test-support/kit-settings-page.js";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { CursorInstances, CursorProviderCard, cursorExtension, loginCommand, searchRows } from "./desktop.js";

const render = (ui: Parameters<typeof renderView>[0]) => renderView(ui, { wrapper: TestProviders });

afterEach(cleanup);

const host = (invoke: (command: string, input?: unknown) => Promise<unknown>) => ({
  invoke: (command: string, input?: unknown) => invoke(command, input),
  onEvent: () => () => undefined,
});

const READY = {
  instance: "default", command: "cursor-agent", path: "/Users/me/.local/bin/cursor-agent", version: "2026.09.18-9a7762b", latest: "2026.10.02-abc1234", updateAvailable: true,
  updateCommand: "/Users/me/.local/bin/cursor-agent update", signedIn: true, account: "me@example.com", plan: "Pro", models: 12,
};

function instances(extra: Record<string, unknown> = {}) {
  const store = new CursorInstances();
  store.set({ instances: [{ id: "default", kind: "cursor", label: "Cursor", threads: 0, ...extra }] });
  return store;
}

describe("Cursor desktop extension", () => {
  it("saves custom model IDs from the runtime card and ignores blank lines", async () => {
    const { registry } = createKitHarness(async (_id, command) => command === "status" ? READY : undefined);
    registry.activate(cursorExtension);
    const page = registry.getSettingsPages().find((entry) => entry.id === "cursor.settings")!;
    const key = "tau.cursor.customModels";
    const { updates } = renderKitSettingsPage(page.Component, { host: { values: { [key]: "gateway/existing" } } });
    const field = await screen.findByRole("textbox", { name: "Custom models" });
    await waitFor(() => expect((field as HTMLTextAreaElement).value).toBe("gateway/existing"));
    fireEvent.change(field, { target: { value: " gateway/one \n \n gateway/two\n\n" } });
    expect(updates).toEqual([]);
    fireEvent.blur(field);
    await waitFor(() => expect(updates).toEqual([{ values: { [key]: "gateway/one\ngateway/two" } }]));
    await waitFor(() => expect((field as HTMLTextAreaElement).value).toBe("gateway/one\ngateway/two"));
    fireEvent.change(field, { target: { value: " \n\n" } });
    fireEvent.blur(field);
    await waitFor(() => expect(updates.at(-1)).toEqual({ values: { [key]: "" } }));
  });

  it("keeps runtime identification out of the status line", () => {
    const { registry } = createKitHarness();
    registry.activate(cursorExtension);
    expect(registry.getStatusItems()).toEqual([]);
    expect(registry.getSettingsPages().find((page) => page.id === "cursor.settings")?.runtime).toBe("cursor");
  });

  it("reports the CLI, the update that is out and the account", async () => {
    const invoke = vi.fn(async () => READY);
    render(<CursorProviderCard onNotify={vi.fn()} host={host(invoke)} instances={instances()} />);
    await waitFor(() => expect(document.getElementById("setting-cursor-program")?.textContent).toContain("2026.09.18-9a7762b · /Users/me/.local/bin/cursor-agent"));
    expect(screen.getByText("me@example.com · Pro")).toBeTruthy();
    expect(screen.getByText("Cursor 2026.10.02-abc1234 is out; 2026.09.18-9a7762b is installed.")).toBeTruthy();
    for (const row of searchRows("default", "Cursor")) expect(document.getElementById(row.id), row.id).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Check again/u }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("status", { fresh: true }));
  });

  it("types the login for the instance's home into a terminal when the CLI is signed out, without showing it", async () => {
    const onNotify = vi.fn();
    const terminal = { invoke: vi.fn(async (command: string) => command === "open" ? { id: "term-1" } : undefined), onEvent: () => () => undefined };
    render(<CursorProviderCard onNotify={onNotify} host={host(async () => ({ ...READY, signedIn: false, account: undefined, plan: undefined, models: undefined }))} instances={instances({ home: "/shadow" })} terminal={terminal} />);
    await waitFor(() => expect(screen.getByText("Not signed in")).toBeTruthy());
    expect(screen.queryByText(/cursor-agent login/u)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in in a terminal" }));
    await waitFor(() => expect(terminal.invoke).toHaveBeenCalledWith("input", { id: "term-1", data: "CURSOR_CONFIG_DIR=/shadow CURSOR_DATA_DIR=/shadow AGENT_CLI_CREDENTIAL_STORE=file cursor-agent login" }));
    expect(onNotify).toHaveBeenCalledWith("The command is in a terminal; press Enter there to run it.");
  });

  it("offers the CLI's installer in a terminal when it is not found", async () => {
    const terminal = { invoke: vi.fn(async (command: string) => command === "open" ? { id: "term-1" } : undefined), onEvent: () => () => undefined };
    render(<CursorProviderCard onNotify={vi.fn()} host={host(async () => ({ command: "cursor-agent" }))} instances={instances()} terminal={terminal} />);
    fireEvent.click(await screen.findByRole("button", { name: "Install in a terminal" }));
    await waitFor(() => expect(terminal.invoke).toHaveBeenCalledWith("input", { id: "term-1", data: "curl https://cursor.com/install -fsS | bash" }));
    expect(screen.queryByText("Account")).toBeNull();
  });

  it("says why an old CLI is not used", async () => {
    render(<CursorProviderCard onNotify={vi.fn()} host={host(async () => ({ ...READY, version: "2025.09.18-7ae6800", unsupported: true, updateAvailable: false }))} instances={instances()} />);
    await waitFor(() => expect(screen.getByText("Tau speaks to Cursor 2026.04.08 and newer; 2025.09.18-7ae6800 is installed.")).toBeTruthy());
    expect(screen.queryByText("Account")).toBeNull();
  });

  it("quotes a home with spaces in the login command", () => {
    expect(loginCommand("cursor-agent", undefined)).toBe("cursor-agent login");
    expect(loginCommand("cursor-agent", "/Users/me/Cursor Work")).toBe('CURSOR_CONFIG_DIR="/Users/me/Cursor Work" CURSOR_DATA_DIR="/Users/me/Cursor Work" AGENT_CLI_CREDENTIAL_STORE=file cursor-agent login');
  });
});
