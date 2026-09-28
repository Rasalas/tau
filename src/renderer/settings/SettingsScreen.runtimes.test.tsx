// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, UiModel, UiRuntimeCatalog } from "../../shared/contracts";
import { ExtensionRegistry } from "../extension-system";
import { HostClientProvider } from "../host-client-context";
import { PreferencesStore } from "../preferences";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { TestProviders } from "../test-support/test-providers";
import { SettingsScreen } from "./SettingsScreen";
import { RUNTIME_PERMISSIONS_ROW } from "./RuntimesPage";

afterEach(cleanup);

const snapshot = {
  cwd: "/work/app",
  models: [],
  thinkingLevels: [],
  defaultBackendKind: "pi",
  runtimeBackends: [
    { kind: "pi", label: "Pi" },
    { kind: "codex", label: "Codex", version: { tool: "codex", installed: "0.48.2", latest: "0.49.0" } },
    { kind: "cursor", label: "Cursor Agent", version: { tool: "cursor-agent" } },
  ],
} as unknown as HostSnapshot;

const catalog = (kind: string, providers: string[], status?: UiRuntimeCatalog["status"]): UiRuntimeCatalog => ({
  kind,
  models: providers.map((provider, index) => ({ provider, id: `${kind}-${index}`, name: `${kind} ${index}` }) as UiModel),
  thinkingLevels: {},
  ...(status ? { status } : {}),
});

/** A host that answers catalogs and records every call a kit makes: the page's buttons must make none. */
function setup(options: { section?: boolean } = {}) {
  const hostCalls: unknown[][] = [];
  const registry = new ExtensionRegistry({ invoke: async (...args: unknown[]) => { hostCalls.push(args); return undefined; } }, { preferences: new PreferencesStore() });
  registry.activate({
    id: "acme.runtimes",
    name: "Runtimes",
    activate(plugin) {
      plugin.registerSettingsPage({ id: "codex.settings", label: "Codex", runtime: "codex", runtimeRows: { program: "setting-codex-program", addInstance: "setting-codex-setup-add" }, Component: () => <p>codex card</p> });
      plugin.registerSettingsPage({ id: "cursor.settings", label: "Cursor Agent", runtime: "cursor", runtimeRows: { program: "setting-cursor-program" }, Component: () => <p>cursor card</p> });
      if (options.section) {
        plugin.registerSettingsSection({ id: "acme.permissions", page: "runtimes", rows: [{ id: RUNTIME_PERMISSIONS_ROW, label: "Before a runtime may…" }], Component: () => <section id={RUNTIME_PERMISSIONS_ROW}>permission cards</section> });
      }
    },
  });
  const client = createFakeHostClient({
    runtimeCatalogs: async () => [
      catalog("pi", ["anthropic", "openai", "anthropic"]),
      catalog("codex", ["openai"]),
      catalog("cursor", [], "not-installed"),
    ],
  });
  const preferences = new PreferencesStore();
  const onSetPage = vi.fn();
  const onNotify = vi.fn();
  render(<HostClientProvider client={client}>
    <TestProviders preferences={preferences}>
      <SettingsScreen page="runtimes" snapshot={snapshot} registry={registry} onSetPage={onSetPage} onSetModel={vi.fn()} onSetThinking={vi.fn()} onClose={vi.fn()} onNotify={onNotify} />
    </TestProviders>
  </HostClientProvider>);
  return { hostCalls, preferences, onSetPage, onNotify, page: screen.getByRole("dialog", { name: "Settings" }) };
}

const row = (name: string) => screen.getByRole("row", { name });

describe("Settings → Runtimes", () => {
  it("lists every runtime with its state, version and the providers it talks to", async () => {
    const { page } = setup();
    expect(within(page.querySelector<HTMLElement>(".settings-page-head")!).getByRole("heading", { level: 1, name: "Runtimes" })).toBeTruthy();
    expect(within(page).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Runtime", "Version", "Talks to", ""]);
    await within(row("Pi")).findByRole("img", { name: "OpenAI" });
    expect(within(row("Pi")).getByText("Default for new threads")).toBeTruthy();
    expect(within(row("Pi")).getByText("Built in")).toBeTruthy();
    expect(within(row("Pi")).getAllByRole("img").map((mark) => mark.getAttribute("aria-label"))).toEqual(["Pi", "Anthropic", "OpenAI"]);
    expect(within(row("Codex")).getByText("Update available")).toBeTruthy();
    expect(within(row("Codex")).getByText("0.48.2 → 0.49.0")).toBeTruthy();
    expect(within(row("Codex")).getByText("codex")).toBeTruthy();
    expect(within(row("Cursor Agent")).getByText("Not installed")).toBeTruthy();
    expect(within(row("Cursor Agent")).getAllByRole("button").map((button) => button.textContent)).toEqual(["Install"]);
  });

  it("makes a runtime the default for new threads on this client", async () => {
    const { preferences, onNotify } = setup();
    await within(row("Pi")).findByRole("img", { name: "OpenAI" });
    fireEvent.click(within(row("Codex")).getByRole("button", { name: "Make default: Codex" }));
    expect(preferences.getSnapshot().newThreadRuntime).toBe("codex");
    expect(onNotify).toHaveBeenCalledWith("New threads start on Codex.");
    expect(within(row("Codex")).getByText("Default for new threads")).toBeTruthy();
    expect(within(row("Pi")).getByRole("button", { name: "Make default: Pi" })).toBeTruthy();
  });

  it("opens the card on Providers for Update, Install and Config and runs nothing itself", async () => {
    const { hostCalls, onSetPage } = setup();
    await within(row("Cursor Agent")).findByText("Not installed");
    fireEvent.click(within(row("Codex")).getByRole("button", { name: "Update: Codex" }));
    expect(onSetPage).toHaveBeenLastCalledWith("codex.settings#setting-codex-program");
    fireEvent.click(within(row("Cursor Agent")).getByRole("button", { name: "Install: Cursor Agent" }));
    expect(onSetPage).toHaveBeenLastCalledWith("cursor.settings#setting-cursor-program");
    fireEvent.click(within(row("Pi")).getByRole("button", { name: "Config: Pi" }));
    expect(onSetPage).toHaveBeenLastCalledWith("pi");
    expect(hostCalls).toEqual([]);
  });

  it("adds a custom runtime as another setup of a program whose card offers one", async () => {
    const { onSetPage, hostCalls } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add a custom runtime" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([expect.stringContaining("Codex")]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Codex/u }));
    expect(onSetPage).toHaveBeenLastCalledWith("codex.settings#setting-codex-setup-add");
    expect(hostCalls).toEqual([]);
  });

  it("draws the kits' sections under the table, and Pi's Permissions opens the one that names itself for it", async () => {
    const { onSetPage, page } = setup({ section: true });
    expect(within(page).getByText("permission cards")).toBeTruthy();
    fireEvent.click(within(row("Pi")).getByRole("button", { name: "Permissions: Pi" }));
    expect(onSetPage).toHaveBeenLastCalledWith("runtimes#runtime-permissions");
    await act(async () => undefined);
  });

  it("finds the default runtime's row in the search, on Runtimes", () => {
    const { page, onSetPage } = setup();
    const search = within(page).getByRole("searchbox", { name: "Search settings" });
    fireEvent.change(search, { target: { value: "runtime for new threads" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSetPage).toHaveBeenCalledWith("runtimes#setting-runtime-for-new-threads");
  });
});
