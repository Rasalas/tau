// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { ClaudeCodeProviderCard, claudeCodeExtension } from "./desktop.js";

afterEach(cleanup);

const host = (invoke: (command: string, input?: unknown) => Promise<unknown>) => ({
  invoke: (command: string, input?: unknown) => invoke(command, input),
  onEvent: () => () => undefined,
});

describe("Claude Code desktop extension", () => {
  it("marks Claude threads in the status line and stays silent for Pi", () => {
    const { registry } = createKitHarness();
    registry.activate(claudeCodeExtension);
    const [item] = registry.getStatusItems();
    expect(item?.id).toBe("claude-code.runtime");
    // Claude Code has no page of its own: it is a card on Providers.
    expect(registry.getSettingsPages().find((page) => page.id === "claude-code.settings")?.runtime).toBe("claude-code");
    const Component = item!.Component;
    const actions = {} as never;
    const { rerender } = render(<Component snapshot={{ backendKind: "claude-code" } as HostSnapshot} actions={actions} />);
    expect(screen.getByText("Claude Code")).toBeTruthy();
    rerender(<Component snapshot={{ backendKind: "pi" } as HostSnapshot} actions={actions} />);
    expect(screen.queryByText("Claude Code")).toBeNull();
  });

  it("reports the CLI and the account it is signed in as, and asks the CLI again on demand", async () => {
    const invoke = vi.fn(async (command: string, input?: unknown) => command === "status"
      ? { kind: "claude-code", command: "claude", path: "/usr/local/bin/claude" }
      : { version: "2.1.4", account: "Claude Max", defaultModel: "sonnet", effort: "medium", models: [{ id: "sonnet", name: "Sonnet 5" }, { id: "haiku", name: "Haiku 4.5" }], fresh: (input as { fresh?: boolean } | undefined)?.fresh });
    render(<ClaudeCodeProviderCard onNotify={vi.fn()} host={host(invoke)} />);
    await waitFor(() => expect(screen.getByText("Found · 2.1.4")).toBeTruthy());
    expect(screen.getByText("/usr/local/bin/claude")).toBeTruthy();
    expect(screen.getByText("Claude Max")).toBeTruthy();
    expect(screen.getByText(/2 models available, sonnet by default, effort medium/u)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Check again/u }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("probe", { fresh: true }));
  });

  it("says when npm has a newer CLI, and saves the executable's path from the card", async () => {
    const invoke = vi.fn(async (command: string) => command === "status"
      ? { kind: "claude-code", command: "claude", path: "/usr/local/bin/claude", update: { installed: "2.1.280", latest: "2.1.300", command: "claude update" } }
      : command === "probe" ? { version: "2.1.280" } : { command: "/opt/claude" });
    const onNotify = vi.fn();
    render(<ClaudeCodeProviderCard onNotify={onNotify} host={host(invoke)} />);
    expect(await screen.findByText(/Claude Code 2\.1\.300 is out; 2\.1\.280 is installed/u)).toBeTruthy();
    expect(screen.getByText("claude update")).toBeTruthy();
    const field = screen.getByRole("textbox", { name: "Claude Code executable" });
    fireEvent.change(field, { target: { value: "/opt/claude" } });
    fireEvent.blur(field);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set-command", { command: "/opt/claude" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("probe", { fresh: true }));
    expect(onNotify).toHaveBeenCalledWith("Claude Code runs from /opt/claude.");
  });

  it("explains a CLI it cannot find instead of showing an empty page", async () => {
    const invoke = vi.fn(async (command: string) => command === "status"
      ? { kind: "claude-code", command: "claude", path: undefined }
      : Promise.reject(new Error("The Claude Code CLI \"claude\" was not found on the PATH of your login shell.")));
    render(<ClaudeCodeProviderCard onNotify={vi.fn()} host={host(invoke)} />);
    await waitFor(() => expect(screen.getByText("claude was not found")).toBeTruthy());
    expect(screen.getByText(/claude.ai\/code, or set its path below/u)).toBeTruthy();
    // The probe's rejection lands one turn after the status; wait for it rather than assume it.
    expect(await screen.findByText(/was not found on the PATH/u)).toBeTruthy();
  });
});
