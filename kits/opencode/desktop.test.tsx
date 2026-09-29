// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { OpenCodeInstances, OpenCodeProviderCard, openCodeExtension, searchRows } from "./desktop.js";

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
  it("keeps runtime identification out of the status line", () => {
    const { registry } = createKitHarness();
    registry.activate(openCodeExtension);
    expect(registry.getStatusItems()).toEqual([]);
    expect(registry.getSettingsPages().find((page) => page.id === "opencode.settings")?.runtime).toBe("opencode");
  });

  it("reports the CLI, the update that is out and the providers OpenCode reaches", async () => {
    const invoke = vi.fn(async () => LOCAL);
    render(<OpenCodeProviderCard onNotify={vi.fn()} host={host(invoke)} instances={instances()} />);
    await waitFor(() => expect(document.getElementById("setting-opencode-program")?.textContent).toContain("1.18.32 · /Users/me/.local/bin/opencode"));
    expect(screen.getByText("OpenCode Zen, OpenRouter")).toBeTruthy();
    expect(screen.getByText("OpenCode 1.19.0 is out; 1.18.32 is installed.")).toBeTruthy();
    for (const row of searchRows("default", "OpenCode")) expect(document.getElementById(row.id), row.id).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Check again/u }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("status", { fresh: true }));
  });

  it("points the instance at a server, then keeps its password without ever showing it", async () => {
    let view: Record<string, unknown> = { id: "default", kind: "opencode", label: "OpenCode", threads: 0 };
    const invoke = vi.fn(async (command: string, input?: unknown) => {
      if (command === "status") return LOCAL;
      const { url, password } = input as { url: string; password?: string };
      view = { ...view, serverUrl: url, hasPassword: password === undefined ? view.hasPassword === true : password !== "" };
      return { instances: [view] };
    });
    const onNotify = vi.fn();
    render(<OpenCodeProviderCard onNotify={onNotify} host={host(invoke)} instances={instances()} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "OpenCode server URL" }).closest("[inert]")).toBeNull());
    const url = screen.getByRole("textbox", { name: "OpenCode server URL" });
    expect(screen.queryByLabelText("OpenCode server password")).toBeNull();
    fireEvent.change(url, { target: { value: "http://10.0.0.2:4096" } });
    fireEvent.blur(url);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set-server", { url: "http://10.0.0.2:4096" }));
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith("OpenCode threads use the server at http://10.0.0.2:4096."));
    const password = await screen.findByLabelText("OpenCode server password");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(password, { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set-server", { url: "http://10.0.0.2:4096", password: "s3cret" }));
    await waitFor(() => expect((screen.getByLabelText("OpenCode server password") as HTMLInputElement).value).toBe(""));
    expect((screen.getByLabelText("OpenCode server password") as HTMLInputElement).placeholder).toMatch(/Saved/u);
    fireEvent.click(screen.getByRole("button", { name: "Forget password" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("set-server", { url: "http://10.0.0.2:4096", password: "" }));
  });

  it("types the login for the instance's home into a terminal when no provider is reachable", async () => {
    const terminal = { invoke: vi.fn(async (command: string) => command === "open" ? { id: "term-1" } : undefined), onEvent: () => () => undefined };
    render(<OpenCodeProviderCard onNotify={vi.fn()} host={host(async () => ({ ...LOCAL, providers: [], signedIn: false, models: 0 }))} instances={instances({ home: "/shadow" })} terminal={terminal} />);
    await waitFor(() => expect(screen.getByText("No provider yet. OpenCode asks for a provider's login or key in a terminal.")).toBeTruthy());
    expect(screen.queryByText(/auth login/u)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add a login in a terminal" }));
    await waitFor(() => expect(terminal.invoke).toHaveBeenCalledWith("input", { id: "term-1", data: "TAU_OPENCODE_HOME=/shadow opencode auth login" }));
  });
});
