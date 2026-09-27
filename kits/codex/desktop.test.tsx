// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, ToastOptions, WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { CodexInstances, CodexProviderCard, codexExtension, createUpdateToasts, createVersionBanner, searchRows } from "./desktop.js";

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
    const { container, rerender } = render(<item.Component snapshot={{ backendKind: "codex" } as HostSnapshot} actions={{} as never} />);
    expect(screen.getByRole("img", { name: "Codex" }).getAttribute("title")).toMatch(/^Codex: /u);
    expect(container.textContent).toBe("");
    rerender(<item.Component snapshot={{ backendKind: "pi" } as HostSnapshot} actions={{} as never} />);
    expect(screen.queryByRole("img", { name: "Codex" })).toBeNull();
  });

  it("reports the CLI, the update that is out and the ChatGPT plan, and asks again on demand", async () => {
    const invoke = vi.fn(async (command: string) => command === "sign-in-state" ? {
      methods: [{ id: "chatgpt", label: "Sign in with ChatGPT", kind: "browser" }],
      account: { signedIn: true, label: "me@example.com", detail: "ChatGPT Pro", canSignOut: true },
    } : {
      command: "codex", path: "/opt/homebrew/bin/codex", version: "0.154.0", latest: "0.155.1", updateCommand: "brew upgrade --cask codex", updateAvailable: true,
      account: { kind: "chatgpt", plan: "pro" }, signedIn: true, models: 5, codexHome: "/Users/me/.codex",
    });
    render(<CodexProviderCard onNotify={vi.fn()} host={host(invoke)} />);
    await waitFor(() => expect(document.getElementById("setting-codex-program")?.textContent).toContain("0.154.0 · /opt/homebrew/bin/codex"));
    expect(screen.queryByText(/brew upgrade/u)).toBeNull();
    expect(screen.getByText("Codex 0.155.1 is out; 0.154.0 is installed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update in a terminal" })).toBeTruthy();
    expect(await screen.findByText("ChatGPT Pro")).toBeTruthy();
    expect(screen.getByText("me@example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
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
    // The row is inert until the host answered; then the field is drawn anew.
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Codex executable" }).closest("[inert]")).toBeNull());
    const field = screen.getByRole("textbox", { name: "Codex executable" });
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
    expect(field.closest("[inert]")).toBeTruthy();
    expect(screen.getByText("Set by TAU_CODEX_COMMAND in Tau's environment.")).toBeTruthy();
  });

  it("offers Codex's ways to sign in when no account is there, and starts the one chosen", async () => {
    const invoke = vi.fn(async (command: string) => command === "sign-in-state"
      ? { methods: [{ id: "chatgpt", label: "Sign in with ChatGPT", kind: "browser" }, { id: "terminal", label: "Sign in in a terminal", kind: "terminal" }], account: { signedIn: false } }
      : command === "sign-in" ? { flowId: "f1", method: "chatgpt", phase: "starting" }
      : { command: "codex", path: "/usr/local/bin/codex", version: "0.155.1", signedIn: false });
    render(<CodexProviderCard onNotify={vi.fn()} host={host(invoke)} />);
    await waitFor(() => expect(screen.getByText("Not signed in")).toBeTruthy());
    fireEvent.click(await screen.findByRole("button", { name: "Sign in", description: "Sign in with ChatGPT" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("sign-in", { target: "default", method: "chatgpt" }));
    expect(await screen.findByText("Starting the Codex sign-in…")).toBeTruthy();
  });

  it("draws a card per instance, after the default one, as the host pushes them", async () => {
    const invoke = vi.fn(async (_extension: string, command: string) => command === "instances"
      ? { instances: [{ id: "default", kind: "codex", label: "Codex", threads: 2 }, { id: "work", kind: "codex@work", label: "Codex · Work", threads: 0 }] }
      : undefined);
    const { registry } = createKitHarness(invoke);
    registry.activate(codexExtension);
    await waitFor(() => expect(registry.getSettingsPages().map((page) => [page.id, page.runtime, page.label])).toEqual([
      ["codex.settings", "codex", "Codex"],
      ["codex.settings.work", "codex@work", "Codex · Work"],
    ]));
    registry.dispatchExtensionEvent({ type: "extension-event", extensionId: "tau.codex", name: "instances", payload: { instances: [{ id: "default", kind: "codex", label: "Codex", threads: 2 }] } });
    expect(registry.getSettingsPages().map((page) => page.id)).toEqual(["codex.settings"]);
    registry.deactivate("tau.codex");
    expect(registry.getSettingsPages()).toEqual([]);
  });

  it("asks for the instance it is about, and removes it after asking", async () => {
    const instances = new CodexInstances();
    instances.set({ instances: [{ id: "default", kind: "codex", label: "Codex", threads: 0 }, { id: "work", kind: "codex@work", label: "Codex · Work", home: "~/.codex-work", threads: 3 }] });
    const invoke = vi.fn(async (command: string) => command === "status"
      ? { instance: "work", command: "codex", path: "/opt/homebrew/bin/codex", version: "0.155.1", signedIn: false }
      : command === "sign-in-state" ? { methods: [], account: { signedIn: false } }
      : { instances: [{ id: "default", kind: "codex", label: "Codex", threads: 0 }] });
    const onNotify = vi.fn();
    render(<CodexProviderCard onNotify={onNotify} host={host(invoke)} instance="work" instances={instances} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("status", { fresh: false, instance: "work" }));
    expect(await screen.findByText("home ~/.codex-work")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("sign-in-state", { target: "work" });
    fireEvent.click(screen.getByRole("button", { name: "Remove…" }));
    expect(screen.getByRole("dialog", { name: "Remove “Codex · Work”?" }).textContent).toMatch(/Its 3 threads leave the thread list/u);
    fireEvent.click(screen.getByRole("button", { name: "Remove instance" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("remove-instance", { instance: "work" }));
    await waitFor(() => expect(instances.snapshot.instances).toHaveLength(1));
    expect(onNotify).toHaveBeenCalledWith("Removed the Codex instance “Codex · Work”.");
  });

  it("adds an instance through the dialog, its id taken from the name", async () => {
    const instances = new CodexInstances();
    instances.set({ instances: [{ id: "default", kind: "codex", label: "Codex", threads: 0 }] });
    const invoke = vi.fn(async (command: string) => command === "status"
      ? { command: "codex", path: "/opt/homebrew/bin/codex", version: "0.155.1" }
      : { instances: [{ id: "default", kind: "codex", label: "Codex", threads: 0 }, { id: "work-account", kind: "codex@work-account", label: "Codex · Work account", threads: 0 }] });
    render(<CodexProviderCard onNotify={vi.fn()} host={host(invoke)} instances={instances} />);
    fireEvent.click(await screen.findByRole("button", { name: /Add instance/u }));
    const dialog = await screen.findByRole("dialog", { name: "Add a Codex instance" });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Work account" } });
    expect((screen.getByLabelText("Instance id") as HTMLInputElement).value).toBe("work-account");
    fireEvent.change(screen.getByLabelText("Home folder"), { target: { value: "~/.codex-work" } });
    fireEvent.change(screen.getByLabelText("Environment"), { target: { value: "not a variable" } });
    fireEvent.click(screen.getByRole("button", { name: "Add instance" }));
    expect(await screen.findByText("Line 1 is not NAME=value.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Environment"), { target: { value: "OPENAI_BASE_URL=http://localhost:1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add instance" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("save-instance", { instance: { id: "work-account", name: "Work account", home: "~/.codex-work", env: { OPENAI_BASE_URL: "http://localhost:1" } } }));
    await waitFor(() => expect(dialog.isConnected).toBe(false));
    expect(instances.snapshot.instances.map((entry) => entry.id)).toEqual(["default", "work-account"]);
  });

  it("draws every row the search names, on the default card and on another instance's", async () => {
    const instances = new CodexInstances();
    instances.set({ instances: [{ id: "default", kind: "codex", label: "Codex", threads: 0 }, { id: "work", kind: "codex@work", label: "Codex · Work", threads: 0 }] });
    const invoke = vi.fn(async (command: string) => command === "sign-in-state"
      ? { methods: [], account: { signedIn: true, label: "me@example.com" } }
      : { command: "codex", path: "/opt/homebrew/bin/codex", version: "0.155.1" });
    for (const [instance, label] of [["default", "Codex"], ["work", "Codex · Work"]] as const) {
      const { unmount } = render(<CodexProviderCard onNotify={vi.fn()} host={host(invoke)} instance={instance} instances={instances} />);
      for (const row of searchRows(instance, label)) await waitFor(() => expect(document.getElementById(row.id), row.id).toBeTruthy());
      unmount();
    }
    const { registry } = createKitHarness();
    registry.activate(codexExtension);
    expect(registry.getSettingsPages()[0]?.rows?.map((row) => row.label)).toEqual(["Codex CLI", "Codex account", "Codex executable", "Codex instance setup"]);
  });

  it("warns above the composer of a thread on an unsafe CLI and types the install command into a terminal without running it", async () => {
    const terminal = { invoke: vi.fn(async (command: string) => command === "open" ? { id: "term-1" } : undefined), onEvent: () => () => undefined };
    const Banner = createVersionBanner(() => terminal);
    const actions = { activeThread: () => ({ workspaceId: "ws-1", draftPending: false }), openPanel: vi.fn(), notify: vi.fn(), copyText: vi.fn(async () => undefined) } as unknown as WorkbenchActions;
    const snapshot = {
      backendKind: "codex@work",
      runtimeBackends: [{ kind: "codex@work", label: "Codex · Work", version: { tool: "codex", installed: "0.155.0", compatibility: { status: "unsafe", recommendedVersion: "0.160.0", installCommand: "npm install -g @openai/codex@0.160.0" } } }],
    } as unknown as HostSnapshot;
    const { rerender } = render(<Banner snapshot={snapshot} actions={actions} />);
    expect(await screen.findByText("Codex · Work 0.155.0 has known problems with Tau")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Install 0\.160\.0 in a terminal/u }));
    await waitFor(() => expect(terminal.invoke).toHaveBeenCalledWith("input", { id: "term-1", data: "npm install -g @openai/codex@0.160.0" }));
    expect(terminal.invoke).toHaveBeenCalledWith("open", { workspaceId: "ws-1", label: "Codex" });
    expect(actions.openPanel).toHaveBeenCalledWith("terminal");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss the Codex · Work version warning" }));
    expect(screen.queryByText(/has known problems/u)).toBeNull();
    rerender(<Banner snapshot={{ ...snapshot, backendKind: "pi" } as HostSnapshot} actions={actions} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers a new release as a toast, runs its update command in Terminal Kit's shell on Update, and asks the instance again", async () => {
    // The newest toast per id, as the workbench's stack keeps them.
    const toasts = new Map<string, ToastOptions>();
    const actions = { toast: (options: ToastOptions) => { toasts.set(options.id!, options); return { id: options.id!, update: () => undefined, dismiss: () => undefined }; }, openSettings: vi.fn() } as unknown as WorkbenchActions;
    const invoke = vi.fn(async () => ({ tool: "codex", installed: "0.156.1", latest: "0.156.1" }));
    const run = vi.fn(async () => ({ id: "term-1", exitCode: 0 }));
    let terminal: { run: typeof run } | undefined;
    const Toasts = createUpdateToasts(host(invoke), () => terminal);
    const snapshot = (kind: string, label: string) => ({
      backendKind: "pi",
      runtimeBackends: [
        { kind: "pi", label: "Pi" },
        { kind, label, version: { tool: "codex", installed: "0.155.0", latest: "0.156.1", updateCommand: "brew upgrade --cask codex" } },
      ],
    }) as unknown as HostSnapshot;
    render(<Toasts snapshot={snapshot("codex@work", "Codex · Work")} actions={actions} />);
    await waitFor(() => expect(toasts.get("runtime-update:codex@work")).toBeTruthy());
    const offered = toasts.get("runtime-update:codex@work")!;
    expect(offered.title).toBe("Update available: Codex · Work v0.156.1");
    // No terminal: only the card is offered.
    expect(offered.actions!.map((action) => action.label)).toEqual(["Settings"]);
    offered.actions![0]!.run();
    expect(actions.openSettings).toHaveBeenCalledWith("codex.settings.work");

    cleanup();
    terminal = { run };
    render(<Toasts snapshot={snapshot("codex@home", "Codex · Home")} actions={actions} />);
    await waitFor(() => expect(toasts.get("runtime-update:codex@home")?.actions?.map((action) => action.label)).toEqual(["Settings", "Update"]));
    expect(run).not.toHaveBeenCalled();
    toasts.get("runtime-update:codex@home")!.actions![1]!.run();
    await waitFor(() => expect(toasts.get("runtime-update:codex@home")).toMatchObject({ type: "success", title: "Codex · Home updated: v0.156.1" }));
    expect(run).toHaveBeenCalledWith({ command: "brew upgrade --cask codex", label: "Update Codex · Home" }, actions);
    expect(invoke).toHaveBeenCalledWith("recheck", { instance: "home" });
  });
});
