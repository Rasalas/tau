// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { AntigravityProviderCard, antigravityExtension, signInLinks } from "./desktop.js";
import { ANTIGRAVITY_INSTALL_EVENT, type AntigravityInstallEvent } from "./protocol.js";

afterEach(() => { cleanup(); signInLinks.clear(); });

/** A host stub whose install events the test fires by hand. */
function hostStub(invoke: (command: string, input?: unknown) => Promise<unknown>) {
  const listeners = new Map<string, (payload: unknown) => void>();
  return {
    host: { invoke: (command: string, input?: unknown) => input === undefined ? invoke(command) : invoke(command, input), onEvent: (name: string, listener: (payload: unknown) => void) => { listeners.set(name, listener); return () => listeners.delete(name); } },
    emit: (name: string, payload: unknown) => act(() => listeners.get(name)?.(payload)),
  };
}

describe("Antigravity desktop extension", () => {
  it("marks Antigravity threads in the status line and opens a reported sign-in link once", () => {
    const { registry } = createKitHarness();
    registry.activate(antigravityExtension);
    const [item] = registry.getStatusItems();
    expect(item?.id).toBe("antigravity.runtime");
    // Antigravity has no page of its own: it is a card on Providers.
    expect(registry.getSettingsPages().find((page) => page.id === "antigravity.settings")?.runtime).toBe("antigravity");
    const Component = item!.Component;
    const actions = { openExternal: vi.fn(), notify: vi.fn() } as never;
    const { rerender } = render(<Component snapshot={{ backendKind: "antigravity", model: { provider: "google", id: "g", name: "Gemini 3.8 Flash (Low)" } } as HostSnapshot} actions={actions} />);
    expect(screen.getByText("Antigravity")).toBeTruthy();
    rerender(<Component snapshot={{ backendKind: "pi" } as HostSnapshot} actions={actions} />);
    expect(screen.queryByText("Antigravity")).toBeNull();

    const url = "https://accounts.google.com/o/oauth2/v2/auth?state=x";
    act(() => signInLinks.report(url));
    expect((actions as { openExternal: ReturnType<typeof vi.fn> }).openExternal).toHaveBeenCalledWith(url);
    expect(screen.getByLabelText("Open the Google sign-in link")).toBeTruthy();
    act(() => signInLinks.clear());
    expect(screen.queryByText("Antigravity")).toBeNull();
  });

  it("installs the runtime from the Settings page and shows the download's progress", async () => {
    const installed = { installed: true, source: "managed", version: "agy_acp_server_1.1.1", path: "/state/agy_acp_server.par", signedIn: false, available: "agy_acp_server_1.1.1", mcpServers: [], models: 0 };
    let status: unknown = { installed: false, available: "agy_acp_server_1.1.1", message: "Antigravity is not installed." };
    let finish!: () => void;
    const install = new Promise<void>((resolve) => { finish = resolve; });
    const invoke = vi.fn(async (command: string) => {
      if (command === "status") return status;
      if (command === "sign-in-state") return { methods: [], account: { signedIn: false } };
      await install;
      status = installed;
      return { version: "agy_acp_server_1.1.1" };
    });
    const { host, emit } = hostStub(invoke);
    const onNotify = vi.fn();
    render(<AntigravityProviderCard onNotify={onNotify} host={host} />);
    // The page says "Checking…" until the host answers, so this waits for a real state.
    expect(screen.getAllByText("Checking…").length).toBeGreaterThan(0);
    fireEvent.click(await screen.findByRole("button", { name: /Install agy_acp_server_1\.1\.1/u }));
    expect(screen.getByText("Not installed")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Installing…")).toBeTruthy());
    emit(ANTIGRAVITY_INSTALL_EVENT, { phase: "downloading", downloadedBytes: 150 * 1024 * 1024, totalBytes: 300 * 1024 * 1024 } satisfies AntigravityInstallEvent);
    expect(screen.getByRole("status").textContent).toBe("Downloading 50% (150 of 300 MB)");
    emit(ANTIGRAVITY_INSTALL_EVENT, { phase: "verifying" } satisfies AntigravityInstallEvent);
    expect(screen.getByRole("status").textContent).toBe("Verifying…");

    finish();
    await waitFor(() => expect(screen.getByText(/^Installed/u)).toBeTruthy());
    expect(onNotify).toHaveBeenCalledWith("Antigravity is installed.");
    expect(screen.queryByRole("button", { name: /Install/u })).toBeNull();
  });

  it("signs out through the sign-in commands, keeps the Google Cloud project and reports what reaches the agent", async () => {
    const status = { installed: true, source: "managed", version: "1.1.1", path: "/p", signedIn: true, available: "1.1.1", mcpServers: ["pencil"], models: 11, gcpProject: "acme-dev", gcpLocation: "us-central1" };
    let signedIn = true;
    const invoke = vi.fn(async (command: string) => {
      if (command === "sign-out") { signedIn = false; return { methods: [{ id: "oauth-personal", label: "Sign in with Google", kind: "browser" }], account: { signedIn: false }, note: "Signed out of Antigravity." }; }
      if (command === "sign-in-state") return { methods: [{ id: "oauth-personal", label: "Sign in with Google", kind: "browser" }], account: signedIn ? { signedIn: true, label: "Google account", canSignOut: true } : { signedIn: false } };
      return command === "status" ? status : undefined;
    });
    const { host } = hostStub(invoke);
    const onNotify = vi.fn();
    render(<AntigravityProviderCard onNotify={onNotify} host={host} />);
    expect(await screen.findByText("Google account")).toBeTruthy();
    expect(screen.getByText(/pencil/u)).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText("Google Cloud project") as HTMLInputElement).value).toBe("acme-dev"));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Sign out" }).at(-1)!);
    await waitFor(() => expect(screen.getByText("Not signed in")).toBeTruthy());
    expect(onNotify).toHaveBeenCalledWith("Signed out of Antigravity.");
    expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeTruthy();

    const field = screen.getByLabelText("Google Cloud location");
    fireEvent.change(field, { target: { value: "europe-west4" } });
    fireEvent.blur(field);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set-sign-in", { gcpProject: "acme-dev", gcpLocation: "europe-west4" }));
  });

  it("says so when the page cannot reach its host half", async () => {
    const { host } = hostStub(async () => { throw new Error("host is gone"); });
    render(<AntigravityProviderCard onNotify={vi.fn()} host={host} />);
    await waitFor(() => expect(screen.getAllByText("host is gone").length).toBeGreaterThan(0));
  });
});
