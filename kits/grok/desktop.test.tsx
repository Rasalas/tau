// @vitest-environment jsdom
import { cleanup, fireEvent, render as renderView, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import { renderKitSettingsPage } from "../../src/renderer/test-support/kit-settings-page.js";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { GrokInstances, GrokProviderCard, grokExtension, loginCommand, searchRows } from "./desktop.js";

const render = (ui: Parameters<typeof renderView>[0]) => renderView(ui, { wrapper: TestProviders });

afterEach(cleanup);

const host = (invoke: (command: string, input?: unknown) => Promise<unknown>) => ({
  invoke: (command: string, input?: unknown) => invoke(command, input),
  onEvent: () => () => undefined,
});

const READY = { instance: "default", command: "grok", path: "/Users/me/.local/bin/grok", version: "0.9.12", login: "account", signedIn: true, account: "grok.com", models: 2 };

function instances(extra: Record<string, unknown> = {}) {
  const store = new GrokInstances();
  store.set({ instances: [{ id: "default", kind: "grok", label: "Grok", threads: 0, ...extra }] });
  return store;
}

describe("Grok desktop extension", () => {
  it("saves custom model IDs from the runtime card and ignores blank lines", async () => {
    const { registry } = createKitHarness(async (_id, command) => command === "status" ? READY : undefined);
    registry.activate(grokExtension);
    const page = registry.getSettingsPages().find((entry) => entry.id === "grok.settings")!;
    const key = "tau.grok.customModels";
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
    registry.activate(grokExtension);
    expect(registry.getStatusItems()).toEqual([]);
    expect(registry.getSettingsPages().find((page) => page.id === "grok.settings")?.runtime).toBe("grok");
  });

  it("reports the CLI and the login", async () => {
    const invoke = vi.fn(async () => READY);
    render(<GrokProviderCard onNotify={vi.fn()} host={host(invoke)} instances={instances()} />);
    await waitFor(() => expect(document.getElementById("setting-grok-program")?.textContent).toContain("0.9.12 · /Users/me/.local/bin/grok"));
    expect(screen.getByText("Signed in with grok.com")).toBeTruthy();
    expect(screen.getByText("2 models; pick one and its reasoning effort per thread in the composer.")).toBeTruthy();
    for (const row of searchRows("default", "Grok")) expect(document.getElementById(row.id), row.id).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Check again/u }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("status", { fresh: true }));
  });

  it("types the login for the instance's home into a terminal when the CLI is signed out, and offers none for an API key", async () => {
    const onNotify = vi.fn();
    const terminal = { invoke: vi.fn(async (command: string) => command === "open" ? { id: "term-1" } : undefined), onEvent: () => () => undefined };
    render(<GrokProviderCard onNotify={onNotify} host={host(async () => ({ ...READY, signedIn: false, account: undefined, models: undefined }))} instances={instances({ home: "/shadow" })} terminal={terminal} />);
    await waitFor(() => expect(screen.getByText("Not signed in")).toBeTruthy());
    expect(screen.queryByText(/grok login/u)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in in a terminal" }));
    await waitFor(() => expect(terminal.invoke).toHaveBeenCalledWith("input", { id: "term-1", data: "GROK_HOME=/shadow grok login" }));
    expect(onNotify).toHaveBeenCalledWith("The command is in a terminal; press Enter there to run it.");
    cleanup();
    render(<GrokProviderCard onNotify={vi.fn()} host={host(async () => ({ ...READY, login: "api-key", account: "XAI_API_KEY" }))} instances={instances()} />);
    await waitFor(() => expect(screen.getByText("xAI API key: XAI_API_KEY is set in Tau's environment; threads are billed to the API.")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Sign in in a terminal" })).toBeNull();
  });

  it("quotes a home with spaces in the login command", () => {
    expect(loginCommand("grok", undefined)).toBe("grok login");
    expect(loginCommand("grok", "/Users/me/Grok Work")).toBe('GROK_HOME="/Users/me/Grok Work" grok login');
  });
});
