// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { GrokInstances, GrokProviderCard, grokExtension, loginCommand, searchRows } from "./desktop.js";

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
  it("marks Grok threads in the status line and fills a card on Providers", () => {
    const { registry } = createKitHarness();
    registry.activate(grokExtension);
    expect(registry.getSettingsPages().find((page) => page.id === "grok.settings")?.runtime).toBe("grok");
    const item = registry.getStatusItems().find((entry) => entry.id === "grok.runtime")!;
    const { container, rerender } = render(<item.Component snapshot={{ backendKind: "grok@work", runtimeBackends: [{ kind: "grok@work", label: "Grok · Work" }] } as HostSnapshot} actions={{} as never} />);
    expect(screen.getByRole("img", { name: "Grok · Work" }).getAttribute("title")).toMatch(/^Grok · Work: /u);
    expect(container.textContent).toBe("");
    rerender(<item.Component snapshot={{ backendKind: "codex" } as HostSnapshot} actions={{} as never} />);
    expect(screen.queryByRole("img")).toBeNull();
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
