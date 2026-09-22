// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { CodexSettingsPage, codexExtension } from "./desktop.js";

afterEach(cleanup);

const host = (invoke: (command: string, input?: unknown) => Promise<unknown>) => ({
  invoke: (command: string, input?: unknown) => invoke(command, input),
  onEvent: () => () => undefined,
});

describe("Codex desktop extension", () => {
  it("marks Codex threads in the status line and stays silent for others", () => {
    const { registry } = createKitHarness();
    registry.activate(codexExtension);
    const item = registry.getStatusItems().find((entry) => entry.id === "codex.runtime")!;
    expect(registry.getSettingsPages().map((page) => page.id)).toContain("codex.settings");
    const { rerender } = render(<item.Component snapshot={{ backendKind: "codex" } as HostSnapshot} actions={{} as never} />);
    expect(screen.getByText("Codex")).toBeTruthy();
    rerender(<item.Component snapshot={{ backendKind: "pi" } as HostSnapshot} actions={{} as never} />);
    expect(screen.queryByText("Codex")).toBeNull();
  });

  it("reports the CLI, the update that is out and the ChatGPT plan, and asks again on demand", async () => {
    const invoke = vi.fn(async () => ({
      command: "codex", path: "/opt/homebrew/bin/codex", version: "0.154.0", latest: "0.155.1", updateCommand: "brew upgrade --cask codex", updateAvailable: true,
      account: { kind: "chatgpt", plan: "pro" }, signedIn: true, models: 5, codexHome: "/Users/me/.codex",
    }));
    render(<CodexSettingsPage onNotify={vi.fn()} host={host(invoke)} />);
    await waitFor(() => expect(screen.getByText("Found · 0.154.0")).toBeTruthy());
    expect(screen.getByText("brew upgrade --cask codex")).toBeTruthy();
    expect(screen.getByText(/Codex 0\.155\.1 is out/u)).toBeTruthy();
    expect(screen.getByText("ChatGPT Pro")).toBeTruthy();
    expect(screen.getByText("/Users/me/.codex")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Check again/u }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("status", { fresh: true }));
  });

  it("tells the user to sign in with the CLI when no account is there", async () => {
    render(<CodexSettingsPage onNotify={vi.fn()} host={host(async () => ({ command: "codex", path: "/usr/local/bin/codex", version: "0.155.1", signedIn: false }))} />);
    await waitFor(() => expect(screen.getByText("Not signed in")).toBeTruthy());
    expect(screen.getByText("codex login")).toBeTruthy();
  });
});
