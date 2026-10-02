// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, ToastOptions, WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { CodexInstances, CodexProviderCard, codexExtension, createUpdateToasts, createVersionBanner, createChatGPTPlanBanner, searchRows } from "./desktop.js";

afterEach(cleanup);

const host = (invoke: (command: string, input?: unknown) => Promise<unknown>) => ({
  invoke: (command: string, input?: unknown) => invoke(command, input),
  onEvent: () => () => undefined,
});

describe("Codex desktop extension", () => {
  it("keeps runtime identification out of the status line", () => {
    const { registry } = createKitHarness();
    registry.activate(codexExtension);
    expect(registry.getStatusItems()).toEqual([]);
    expect(registry.getSettingsPages().find((page) => page.id === "codex.settings")?.runtime).toBe("codex");
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
    expect(screen.queryByText("me@example.com")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show email address" }));
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
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("sign-in-state", { target: "work" }));
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

describe("ChatGPT plan UI", () => {
  it("offers Continue with ChatGPT when permission is missing and opens plan usage controls", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const invoke = vi.fn(async (command: string) => command === "sign-in-state" ? {
      methods: [{ id: "chatgpt-plan", label: "Continue with ChatGPT", actionLabel: "Continue with ChatGPT", kind: "browser" }], account: { signedIn: false },
    } : { command: "codex", chatgptPlan: { signedIn: false, label: "fixture@example.test", usageUrl: "https://chatgpt.com/settings/usage" } });
    render(<CodexProviderCard onNotify={vi.fn()} host={host(invoke)} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue with ChatGPT" })).toBeTruthy());
    fireEvent.click(await screen.findByRole("button", { name: "Manage usage" }));
    expect(open).toHaveBeenCalledWith("https://chatgpt.com/settings/usage", "_blank", "noopener");
    expect(screen.queryByText("fixture@example.test")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show email address" }));
    expect(screen.getByText("fixture@example.test")).toBeTruthy();
    open.mockRestore();
  });

  it("keeps plan connection reachable while a new instance inherits a signed-in CLI account", async () => {
    const invoke = vi.fn(async (command: string) => command === "sign-in-state" ? {
      methods: [{ id: "chatgpt-plan", label: "Continue with ChatGPT", actionLabel: "Continue with ChatGPT", availableWhenSignedIn: true, kind: "browser" }, { id: "chatgpt", label: "CLI sign-in", kind: "browser" }],
      account: { signedIn: true, label: "CLI account" },
    } : { command: "codex" });
    render(<CodexProviderCard onNotify={vi.fn()} host={host(invoke)} />);
    expect(await screen.findByRole("button", { name: "Continue with ChatGPT" })).toBeTruthy();
    expect(screen.queryByText("CLI sign-in")).toBeNull();
  });

  it("offers an explicit managed install repair for a registered account", async () => {
    const invoke = vi.fn(async (command: string) => command === "sign-in-state" ? { methods: [], account: { signedIn: true } } : { command: "codex", chatgptPlan: { signedIn: true, label: "fixture@example.test", usageUrl: "https://chatgpt.com/settings/usage", needsInstall: true } });
    render(<CodexProviderCard onNotify={vi.fn()} host={host(invoke)} />);
    const button = await screen.findByRole("button", { name: "Install managed Codex" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("managed-codex-install", {}));
  });

  it("shows Tau fetching its Codex on the card, and reads the status again once it is ready", async () => {
    const listeners = new Map<string, (value: unknown) => void>();
    let ready = false;
    const invoke = vi.fn(async (command: string) => command === "sign-in-state" ? { methods: [], account: { signedIn: true } }
      : ready ? { command: "codex", path: "/state/managed-codex/0.160.0/bin/codex", version: "0.160.0", chatgptPlan: { signedIn: true, label: "fixture@example.test", usageUrl: "https://chatgpt.com/settings/usage" } }
        : { command: "codex", message: "Tau is fetching Codex 0.160.0; this instance uses it once it is ready.", chatgptPlan: { signedIn: true, label: "fixture@example.test", usageUrl: "https://chatgpt.com/settings/usage" }, managedInstall: { version: "0.160.0", phase: "downloading" } });
    const client = { invoke, onEvent: (name: string, listener: (value: unknown) => void) => { listeners.set(name, listener); return () => listeners.delete(name); } };
    render(<CodexProviderCard onNotify={vi.fn()} host={client} />);
    await screen.findByText("Downloading Codex 0.160.0…");
    await waitFor(() => expect(listeners.has("managed-codex")).toBe(true));
    listeners.get("managed-codex")!({ version: "0.160.0", phase: "downloading", downloadedBytes: 64 * 1024 * 1024, totalBytes: 128 * 1024 * 1024 });
    await screen.findByText("Downloading Codex 0.160.0… 50% (64 of 128 MB)");
    expect(screen.queryByRole("button", { name: "Install managed Codex" })).toBeNull();
    ready = true;
    listeners.get("managed-codex")!({ version: "0.160.0", phase: "installed" });
    await waitFor(() => expect(document.getElementById("setting-codex-program")?.textContent).toContain("0.160.0"));
    await waitFor(() => expect(screen.queryByText(/Downloading Codex/u)).toBeNull());
  });

  it("offers to try again when fetching Tau's Codex failed", async () => {
    const invoke = vi.fn(async (command: string) => command === "sign-in-state" ? { methods: [], account: { signedIn: true } }
      : { command: "codex", chatgptPlan: { signedIn: true, label: "fixture@example.test", usageUrl: "https://chatgpt.com/settings/usage", needsInstall: true }, managedInstall: { version: "0.160.0", phase: "failed", error: "Codex download failed (503). Try again." } });
    render(<CodexProviderCard onNotify={vi.fn()} host={host(invoke)} />);
    expect((await screen.findByRole("alert")).textContent).toBe("Tau could not fetch Codex 0.160.0. Codex download failed (503). Try again.");
    const button = screen.getByRole("button", { name: "Try again" }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("managed-codex-install", {}));
  });

  it("shows the active account beside the composer and directs a limit error to Manage usage", async () => {
    const listeners = new Map<string, (value: unknown) => void>();
    const client = { invoke: vi.fn(async () => ({ signedIn: true, label: "fixture@example.test", usageUrl: "https://chatgpt.com/settings/usage" })), onEvent: (name: string, listener: (value: unknown) => void) => { listeners.set(name, listener); return () => listeners.delete(name); } };
    const Banner = createChatGPTPlanBanner(client);
    const actions = { openExternal: vi.fn() } as unknown as WorkbenchActions;
    render(<Banner snapshot={{ backendKind: "codex@work" } as HostSnapshot} actions={actions} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show email address" }));
    expect(screen.getByText("fixture@example.test")).toBeTruthy();
    expect(client.invoke).toHaveBeenCalledWith("chatgpt-plan-account", { instance: "work" });
    listeners.get("chatgpt-plan-limit")!({ instance: "work" });
    await screen.findByText(/Review your app limits and credits/u);
    listeners.get("managed-codex")!({ version: "0.160.0", phase: "extracting" });
    await screen.findByText("Unpacking Codex 0.160.0…");
    fireEvent.click(screen.getByRole("button", { name: "Manage usage" }));
    expect(actions.openExternal).toHaveBeenCalledWith("https://chatgpt.com/settings/usage");
  });
});

it("renders dynamic Ultrafast tiers and compatible accounts, then displays a switch error", async () => {
  const { createThreadSettingsControl } = await import("./desktop.js");
  const state = { account: "default", accounts: [{ id: "default", label: "Personal" }, { id: "work", label: "Work" }, { id: "other", label: "Other", reason: "Different shared home" }], serviceTier: { selected: null, defaultTier: "ultrafast", choices: [{ id: "ultrafast", name: "Ultrafast", description: "Provider description" }, { id: "future", name: "Future tier" }] } };
  const invoke = vi.fn(async (command: string) => { if (command === "switch-thread-account") throw new Error("Account cannot resume this session"); return state; });
  const Control = createThreadSettingsControl(host(invoke));
  render(<Control snapshot={{ sessionId: "thread", backendKind: "codex", isStreaming: false } as HostSnapshot} />);
  // Ultrafast is the thinking chip's Fast (K142); the menu keeps the other tiers.
  const future = await screen.findByRole("radio", { name: /^Future tier/u });
  expect(screen.queryByRole("radio", { name: /^Ultrafast/u })).toBeNull();
  fireEvent.click(future);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("set-thread-tier", { threadId: "thread", tier: "future" }));
  const other = screen.getByRole("radio", { name: /Other/u });
  expect(other.hasAttribute("disabled")).toBe(true);
  const work = screen.getByRole("radio", { name: /Work/u });
  await waitFor(() => expect(work.hasAttribute("disabled")).toBe(false));
  fireEvent.click(work);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Account cannot resume this session");
});

it("gives the thinking chip Codex's fast tier, and none to a draft", async () => {
  const { createCodexSpeed } = await import("./desktop.js");
  let selected: string | null = null;
  const settings = () => ({ account: "default", accounts: [], serviceTier: { selected, defaultTier: null, choices: [{ id: "default", name: "Standard" }, { id: "fast", name: "Fast", description: "1.5x speed" }] } });
  const invoke = vi.fn(async (command: string, input?: unknown) => {
    if (command === "set-thread-tier") selected = (input as { tier?: string | null } | undefined)?.tier ?? null;
    return settings();
  });
  const speed = createCodexSpeed(host(invoke));
  const changed = vi.fn();
  speed.subscribe(changed);
  const snapshot = { sessionId: "thread", backendKind: "codex", model: { id: "gpt-6-sol" } } as HostSnapshot;
  expect(speed.read({ ...snapshot, backendKind: "pi" } as HostSnapshot)).toBeUndefined();
  speed.read(snapshot);
  await waitFor(() => expect(speed.read(snapshot)).toEqual({ fast: false, available: true, detail: "1.5x speed" }));
  await speed.set(true, snapshot);
  expect(invoke).toHaveBeenCalledWith("set-thread-tier", { threadId: "thread", tier: "fast" });
  expect(speed.read(snapshot)).toMatchObject({ fast: true });
  invoke.mockRejectedValueOnce(new Error("no such thread"));
  const draft = { ...snapshot, sessionId: "draft" } as HostSnapshot;
  speed.read(draft);
  await waitFor(() => expect(speed.read(draft)).toEqual({ fast: false, available: false, reason: "Codex sets Fast once the thread runs" }));
});

it("keeps a managed thread's account banner and limit notices with its executing account after a switch", async () => {
  const listeners = new Map<string, (value: unknown) => void>();
  let account = "default";
  const client = { invoke: vi.fn(async () => ({ instance: account, signedIn: true, label: `${account}@example.test`, usageUrl: "https://chatgpt.com/settings/usage" })), onEvent: (name: string, listener: (value: unknown) => void) => { listeners.set(name, listener); return () => listeners.delete(name); } };
  const Banner = createChatGPTPlanBanner(client);
  render(<Banner snapshot={{ sessionId: "thread", backendKind: "codex" } as HostSnapshot} actions={{ openExternal: vi.fn() } as unknown as WorkbenchActions} />);
  fireEvent.click(await screen.findByRole("button", { name: "Show email address" }));
  expect(screen.getByText("default@example.test")).toBeTruthy();
  account = "work";
  listeners.get("thread-settings")!({ threadId: "thread" });
  const reveal = await screen.findByRole("button", { name: "Show email address" });
  expect(screen.queryByText("default@example.test")).toBeNull();
  expect(screen.queryByText("work@example.test")).toBeNull();
  fireEvent.click(reveal);
  expect(screen.getByText("work@example.test")).toBeTruthy();
  expect(client.invoke).toHaveBeenLastCalledWith("chatgpt-plan-account", { instance: "default", threadId: "thread" });
  listeners.get("chatgpt-plan-limit")!({ instance: "work" });
  await screen.findByText(/Review your app limits and credits/u);
});
