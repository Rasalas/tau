// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { GrokInstances, GrokProviderCard, grokExtension, loginCommand } from "./desktop.js";

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
    await waitFor(() => expect(screen.getByText("Found · 0.9.12")).toBeTruthy());
    expect(screen.getByText("Signed in with grok.com")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Check again/u }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("status", { fresh: true }));
  });

  it("offers the login command for the instance's home when the CLI is signed out, and none for an API key", async () => {
    const onNotify = vi.fn();
    render(<GrokProviderCard onNotify={onNotify} host={host(async () => ({ ...READY, signedIn: false, account: undefined, models: undefined }))} instances={instances({ home: "/shadow" })} />);
    await waitFor(() => expect(screen.getByText("Not signed in")).toBeTruthy());
    expect(screen.getByText("GROK_HOME=/shadow grok login")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in…" }));
    await waitFor(() => expect(onNotify).toHaveBeenCalled());
    cleanup();
    render(<GrokProviderCard onNotify={vi.fn()} host={host(async () => ({ ...READY, login: "api-key", account: "XAI_API_KEY" }))} instances={instances()} />);
    await waitFor(() => expect(screen.getByText("xAI API key")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Sign in…" })).toBeNull();
  });

  it("quotes a home with spaces in the login command", () => {
    expect(loginCommand("grok", undefined)).toBe("grok login");
    expect(loginCommand("grok", "/Users/me/Grok Work")).toBe('GROK_HOME="/Users/me/Grok Work" grok login');
  });
});
