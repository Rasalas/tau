// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { OpenCodeInstances, OpenCodeProviderCard, openCodeExtension } from "./desktop.js";

afterEach(cleanup);

const host = (invoke: (command: string, input?: unknown) => Promise<unknown>) => ({
  invoke: (command: string, input?: unknown) => invoke(command, input),
  onEvent: () => () => undefined,
});

const LOCAL = {
  instance: "default", command: "opencode", path: "/Users/me/.local/bin/opencode", version: "1.18.32", latest: "1.19.0", updateAvailable: true, updateCommand: "npm install -g opencode-ai@latest",
  providers: [{ id: "opencode", name: "OpenCode Zen", models: 8 }, { id: "openrouter", name: "OpenRouter", models: 300 }], signedIn: true, models: 308,
};

function instances(extra: Record<string, unknown> = {}) {
  const store = new OpenCodeInstances();
  store.set({ instances: [{ id: "default", kind: "opencode", label: "OpenCode", threads: 0, ...extra }] });
  return store;
}

describe("OpenCode desktop extension", () => {
  it("marks OpenCode threads in the status line and fills a card on Providers", () => {
    const { registry } = createKitHarness();
    registry.activate(openCodeExtension);
    expect(registry.getSettingsPages().find((page) => page.id === "opencode.settings")?.runtime).toBe("opencode");
    const item = registry.getStatusItems().find((entry) => entry.id === "opencode.runtime")!;
    const { container, rerender } = render(<item.Component snapshot={{ backendKind: "opencode@work", runtimeBackends: [{ kind: "opencode@work", label: "OpenCode · Work" }] } as HostSnapshot} actions={{} as never} />);
    expect(screen.getByRole("img", { name: "OpenCode · Work" }).getAttribute("title")).toMatch(/^OpenCode · Work: /u);
    expect(container.textContent).toBe("");
    rerender(<item.Component snapshot={{ backendKind: "codex" } as HostSnapshot} actions={{} as never} />);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("reports the CLI, the update that is out and the providers OpenCode reaches", async () => {
    const invoke = vi.fn(async () => LOCAL);
    render(<OpenCodeProviderCard onNotify={vi.fn()} host={host(invoke)} instances={instances()} />);
    await waitFor(() => expect(screen.getByText("Found · 1.18.32")).toBeTruthy());
    expect(screen.getByText("OpenCode Zen, OpenRouter")).toBeTruthy();
    expect(screen.getByText(/OpenCode 1\.19\.0 is out/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Check again/u }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("status", { fresh: true }));
  });

  it("points the instance at a server with a password, and never shows a saved password", async () => {
    const invoke = vi.fn(async (command: string) => command === "status" ? LOCAL : { instances: [{ id: "default", kind: "opencode", label: "OpenCode", threads: 0, serverUrl: "http://10.0.0.2:4096", hasPassword: true }] });
    const onNotify = vi.fn();
    const store = instances();
    render(<OpenCodeProviderCard onNotify={onNotify} host={host(invoke)} instances={store} />);
    const url = await screen.findByRole("textbox", { name: "OpenCode server URL" });
    fireEvent.change(url, { target: { value: "http://10.0.0.2:4096" } });
    fireEvent.change(screen.getByLabelText("OpenCode server password"), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set-server", { url: "http://10.0.0.2:4096", password: "s3cret" }));
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith("OpenCode threads use the server at http://10.0.0.2:4096."));
    expect((screen.getByLabelText("OpenCode server password") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("OpenCode server password") as HTMLInputElement).placeholder).toMatch(/Saved/u);
    fireEvent.click(screen.getByRole("button", { name: "Forget password" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set-server", { url: "http://10.0.0.2:4096", password: "" }));
  });

  it("names the login command when no provider is reachable", async () => {
    render(<OpenCodeProviderCard onNotify={vi.fn()} host={host(async () => ({ ...LOCAL, providers: [], signedIn: false, models: 0 }))} instances={instances({ home: "/shadow" })} />);
    await waitFor(() => expect(screen.getByText("No provider yet")).toBeTruthy());
    expect(screen.getByText("TAU_OPENCODE_HOME=/shadow opencode auth login")).toBeTruthy();
  });
});
