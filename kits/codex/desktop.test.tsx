// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { CodexProviderCard, codexExtension } from "./desktop.js";

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
    // Codex has no page of its own: it is a card on Providers.
    expect(registry.getSettingsPages().find((page) => page.id === "codex.settings")?.runtime).toBe("codex");
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
    render(<CodexProviderCard onNotify={vi.fn()} host={host(invoke)} />);
    await waitFor(() => expect(screen.getByText("Found · 0.154.0")).toBeTruthy());
    expect(screen.getByText("brew upgrade --cask codex")).toBeTruthy();
    expect(screen.getByText(/Codex 0\.155\.1 is out/u)).toBeTruthy();
    expect(screen.getByText("ChatGPT Pro")).toBeTruthy();
    expect(screen.getByText("/Users/me/.codex")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Check again/u }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("status", { fresh: true }));
  });

  it("saves the executable's path from the card and reads the status again", async () => {
    const invoke = vi.fn(async (command: string) => command === "status"
      ? { command: "codex", path: "/opt/homebrew/bin/codex", version: "0.155.1", signedIn: false }
      : { command: "/opt/codex/bin/codex" });
    const onNotify = vi.fn();
    render(<CodexProviderCard onNotify={onNotify} host={host(invoke)} />);
    const field = await screen.findByRole("textbox", { name: "Codex executable" });
    await waitFor(() => expect((field as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(field, { target: { value: "/opt/codex/bin/codex" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set-command", { command: "/opt/codex/bin/codex" }));
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith("Codex runs from /opt/codex/bin/codex."));
    expect(invoke).toHaveBeenLastCalledWith("status", { fresh: true });
  });

  it("shows a path the environment set, and does not let the card change it", async () => {
    render(<CodexProviderCard onNotify={vi.fn()} host={host(async () => ({ command: "/dev/codex", commandSource: "env", path: "/dev/codex", version: "0.155.1" }))} />);
    const field = await screen.findByRole("textbox", { name: "Codex executable" });
    await waitFor(() => expect((field as HTMLInputElement).value).toBe("/dev/codex"));
    expect((field as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("TAU_CODEX_COMMAND")).toBeTruthy();
  });

  it("tells the user to sign in with the CLI when no account is there", async () => {
    render(<CodexProviderCard onNotify={vi.fn()} host={host(async () => ({ command: "codex", path: "/usr/local/bin/codex", version: "0.155.1", signedIn: false }))} />);
    await waitFor(() => expect(screen.getByText("Not signed in")).toBeTruthy());
    expect(screen.getByText("codex login")).toBeTruthy();
  });
});
