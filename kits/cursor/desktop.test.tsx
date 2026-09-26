// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { CursorInstances, CursorProviderCard, cursorExtension, loginCommand } from "./desktop.js";

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
  it("marks Cursor threads in the status line and fills a card on Providers", () => {
    const { registry } = createKitHarness();
    registry.activate(cursorExtension);
    expect(registry.getSettingsPages().find((page) => page.id === "cursor.settings")?.runtime).toBe("cursor");
    const item = registry.getStatusItems().find((entry) => entry.id === "cursor.runtime")!;
    const { container, rerender } = render(<item.Component snapshot={{ backendKind: "cursor@work", runtimeBackends: [{ kind: "cursor@work", label: "Cursor · Work" }] } as HostSnapshot} actions={{} as never} />);
    expect(screen.getByRole("img", { name: "Cursor · Work" }).getAttribute("title")).toMatch(/^Cursor · Work: /u);
    expect(container.textContent).toBe("");
    rerender(<item.Component snapshot={{ backendKind: "codex" } as HostSnapshot} actions={{} as never} />);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("reports the CLI, the update that is out and the account", async () => {
    const invoke = vi.fn(async () => READY);
    render(<CursorProviderCard onNotify={vi.fn()} host={host(invoke)} instances={instances()} />);
    await waitFor(() => expect(screen.getByText("Found · 2026.09.18-9a7762b")).toBeTruthy());
    expect(screen.getByText("me@example.com · Pro")).toBeTruthy();
    expect(screen.getByText(/Cursor CLI 2026\.10\.02-abc1234 is out/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Check again/u }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("status", { fresh: true }));
  });

  it("offers the login command for the instance's home when the CLI is signed out", async () => {
    const onNotify = vi.fn();
    render(<CursorProviderCard onNotify={onNotify} host={host(async () => ({ ...READY, signedIn: false, account: undefined, plan: undefined, models: undefined }))} instances={instances({ home: "/shadow" })} />);
    await waitFor(() => expect(screen.getByText("Not signed in")).toBeTruthy());
    expect(screen.getByText("CURSOR_CONFIG_DIR=/shadow CURSOR_DATA_DIR=/shadow AGENT_CLI_CREDENTIAL_STORE=file cursor-agent login")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in…" }));
    await waitFor(() => expect(onNotify).toHaveBeenCalled());
  });

  it("says why an old CLI is not used", async () => {
    render(<CursorProviderCard onNotify={vi.fn()} host={host(async () => ({ ...READY, version: "2025.09.18-7ae6800", unsupported: true, updateAvailable: false }))} instances={instances()} />);
    await waitFor(() => expect(screen.getByText(/Tau speaks to the Cursor CLI 2026\.04\.08 and newer/u)).toBeTruthy());
    expect(screen.queryByText("Account")).toBeNull();
  });

  it("quotes a home with spaces in the login command", () => {
    expect(loginCommand("cursor-agent", undefined)).toBe("cursor-agent login");
    expect(loginCommand("cursor-agent", "/Users/me/Cursor Work")).toBe('CURSOR_CONFIG_DIR="/Users/me/Cursor Work" CURSOR_DATA_DIR="/Users/me/Cursor Work" AGENT_CLI_CREDENTIAL_STORE=file cursor-agent login');
  });
});
