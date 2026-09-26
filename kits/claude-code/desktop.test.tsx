// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, ToastOptions, WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { ClaudeCodeProviderCard, ClaudeInstances, claudeCodeExtension, createUpdateToasts, createVersionBanner } from "./desktop.js";

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
    const { container, rerender } = render(<Component snapshot={{ backendKind: "claude-code" } as HostSnapshot} actions={actions} />);
    // Icon only: the name lives in the accessible label and the tooltip.
    const mark = screen.getByRole("img", { name: "Claude Code" });
    expect(mark.getAttribute("title")).toMatch(/^Claude Code: /u);
    expect(container.textContent).toBe("");
    rerender(<Component snapshot={{ backendKind: "pi" } as HostSnapshot} actions={actions} />);
    expect(screen.queryByRole("img", { name: "Claude Code" })).toBeNull();
  });

  it("reports the CLI and the account it is signed in as, and asks the CLI again on demand", async () => {
    const invoke = vi.fn(async (command: string, input?: unknown) => command === "status"
      ? { kind: "claude-code", command: "claude", path: "/usr/local/bin/claude" }
      : command === "sign-in-state" ? { methods: [], account: { signedIn: true, label: "me@example.com", detail: "Claude Max", canSignOut: true } }
      : { version: "2.1.4", account: "Claude Max", defaultModel: "sonnet", effort: "medium", models: [{ id: "sonnet", name: "Sonnet 5" }, { id: "haiku", name: "Haiku 4.5" }], fresh: (input as { fresh?: boolean } | undefined)?.fresh });
    render(<ClaudeCodeProviderCard onNotify={vi.fn()} host={host(invoke)} />);
    await waitFor(() => expect(screen.getByText("Found · 2.1.4")).toBeTruthy());
    expect(screen.getByText("/usr/local/bin/claude")).toBeTruthy();
    expect(await screen.findByText("Claude Max")).toBeTruthy();
    expect(screen.getByText("me@example.com")).toBeTruthy();
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
      : command === "sign-in-state" ? { methods: [{ id: "plan", label: "Sign in with a Claude plan", kind: "terminal", unavailable: "Install the CLI first; \"claude\" was not found." }], account: { signedIn: false } }
      : Promise.reject(new Error("The Claude Code CLI \"claude\" was not found on the PATH of your login shell.")));
    render(<ClaudeCodeProviderCard onNotify={vi.fn()} host={host(invoke)} />);
    await waitFor(() => expect(screen.getByText("claude was not found")).toBeTruthy());
    expect(screen.getByText(/claude.ai\/code, or set its path below/u)).toBeTruthy();
    // The probe's rejection lands one turn after the status; wait for it rather than assume it.
    expect(await screen.findByText(/was not found on the PATH/u)).toBeTruthy();
    expect(await screen.findByText(/Install the CLI first/u)).toBeTruthy();
  });

  it("draws a card per instance and asks each for its own status", async () => {
    const report = { instances: [{ id: "default", kind: "claude-code", label: "Claude Code", threads: 0 }, { id: "second", kind: "claude-code@second", label: "Claude Code · Second", home: "~/.claude-second", threads: 1 }] };
    const { registry } = createKitHarness(async (_extension, command) => command === "instances" ? report : undefined);
    registry.activate(claudeCodeExtension);
    await waitFor(() => expect(registry.getSettingsPages().map((page) => page.runtime)).toEqual(["claude-code", "claude-code@second"]));

    const instances = new ClaudeInstances();
    instances.set(report);
    const invoke = vi.fn(async (command: string) => command === "status"
      ? { kind: "claude-code@second", instance: "second", command: "claude", path: "/usr/local/bin/claude" }
      : { version: "2.1.4" });
    render(<ClaudeCodeProviderCard onNotify={vi.fn()} host={host(invoke)} instance="second" instances={instances} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("status", { instance: "second" }));
    expect(invoke).toHaveBeenCalledWith("probe", { fresh: false, instance: "second" });
    expect(await screen.findByText("home ~/.claude-second")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("sign-in-state", { target: "second" });
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("warns above the composer of a thread whose CLI is broken, and copies the command", async () => {
    const Banner = createVersionBanner(() => ({ invoke: async () => { throw new Error("no terminal"); }, onEvent: () => () => undefined }));
    const actions = { activeThread: () => undefined, openPanel: vi.fn(), notify: vi.fn(), copyText: vi.fn(async () => undefined) } as unknown as WorkbenchActions;
    const snapshot = { backendKind: "claude-code", runtimeBackends: [{ kind: "claude-code", label: "Claude Code", version: { tool: "claude", installed: "2.1.280", updateCommand: "claude update", compatibility: { status: "broken", message: "It drops tool results." } } }] } as unknown as HostSnapshot;
    render(<Banner snapshot={snapshot} actions={actions} />);
    expect((await screen.findByRole("alert")).textContent).toContain("It drops tool results.");
    fireEvent.click(screen.getByRole("button", { name: /Update in a terminal/u }));
    await waitFor(() => expect(actions.copyText).toHaveBeenCalledWith("claude update"));
    expect(actions.notify).toHaveBeenCalledWith("No terminal is available; the command is on the clipboard.");
  });

  it("offers a new release of the default instance's CLI and opens its card from Settings", async () => {
    const toasts = new Map<string, ToastOptions>();
    const actions = { toast: (options: ToastOptions) => { toasts.set(options.id!, options); return { id: options.id!, update: () => undefined, dismiss: () => undefined }; }, openSettings: vi.fn() } as unknown as WorkbenchActions;
    const invoke = vi.fn(async () => ({ tool: "claude", installed: "2.1.300", latest: "2.1.300" }));
    const run = vi.fn(async () => ({ id: "term-1", exitCode: 0 }));
    const Toasts = createUpdateToasts(host(invoke), () => ({ run }));
    const snapshot = { runtimeBackends: [{ kind: "claude-code", label: "Claude Code", version: { tool: "claude", installed: "2.1.280", latest: "2.1.300", updateCommand: "claude update" } }] } as unknown as HostSnapshot;
    render(<Toasts snapshot={snapshot} actions={actions} />);
    await waitFor(() => expect(toasts.get("runtime-update:claude-code")?.title).toBe("Update available: Claude Code v2.1.300"));
    toasts.get("runtime-update:claude-code")!.actions![0]!.run();
    expect(actions.openSettings).toHaveBeenCalledWith("claude-code.settings");
    toasts.get("runtime-update:claude-code")!.actions![1]!.run();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("recheck", { instance: "default" }));
    expect(run).toHaveBeenCalledWith({ command: "claude update", label: "Update Claude Code" }, actions);
  });
});
