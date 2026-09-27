// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, TauConfig } from "../shared/contracts";
import { createMemoryStorage, setClientStorage } from "../workbench/client-storage";
import { applyHostEvent, type HostEventTargets } from "../workbench/host-events";
import { followExtensionChoices } from "./extension-choices";
import { ExtensionRegistry, type DesktopExtension } from "./extension-system";
import { HostClientProvider } from "./host-client-context";
import { PreferencesStore } from "./preferences";
import { SettingsScreen } from "./settings/SettingsScreen";
import { extensionCatalog } from "./settings/extension-catalog";
import { createFakeHostClient, type FakeHostClient } from "./test-support/fake-host-client";
import { TestProviders } from "./test-support/test-providers";

afterEach(cleanup);
beforeEach(() => setClientStorage(createMemoryStorage()));

/** One host's config, and the push every client connected to it hears after a write. */
function sharedHost(initial: TauConfig = {}) {
  const host = { config: initial, clients: [] as FakeHostClient[] };
  const connect = (options: { readOnly?: boolean } = {}) => {
    const client = createFakeHostClient({
      getConfig: async () => host.config,
      updateConfig: async (patch) => {
        host.config = { ...host.config, ...patch };
        queueMicrotask(() => host.clients.forEach((each) => each.emit({ type: "config-changed", kind: "config", paths: ["/home/.tau/config.json"] })));
        return host.config;
      },
      isReadOnly: () => options.readOnly ?? false,
    });
    host.clients.push(client);
    return client;
  };
  return { host, connect };
}

/** A client as the workbench builds one: its preferences, its registry, the kit, and the host's pushes routed. */
function device(client: FakeHostClient) {
  const preferences = new PreferencesStore();
  const registry = new ExtensionRegistry(undefined, { preferences });
  const mounted = { count: 0 };
  const kit: DesktopExtension = {
    id: "tau.signals",
    name: "Signals",
    activate: () => { mounted.count += 1; return () => { mounted.count -= 1; }; },
  };
  registry.addKnown(kit);
  if (preferences.isExtensionEnabled(kit.id)) registry.activate(kit);
  followExtensionChoices(registry, preferences);
  client.onHostEvent((event) => applyHostEvent(event, { registry, preferences } as unknown as HostEventTargets));
  preferences.bindHost(client);
  return { client, preferences, registry, mounted };
}

/** The switch Settings shows: this client's preference, then this client's half. */
function toggle(on: ReturnType<typeof device>, id: string, enabled: boolean) {
  on.preferences.setExtensionEnabled(id, enabled);
  on.registry.setActive(id, enabled);
}

/** Every write, push and re-read the fake host chains are microtasks; one macrotask later they are done. */
const settled = () => act(() => new Promise<void>((resolve) => { setTimeout(resolve, 0); }));

describe("extensions on and off across clients", () => {
  it("stops a kit on the phone when the desktop turns it off, and starts it on the desktop when the phone turns it back on", async () => {
    const { host, connect } = sharedHost();
    const desktop = device(connect());
    const phone = device(connect());
    await settled();
    expect([desktop.mounted.count, phone.mounted.count]).toEqual([1, 1]);

    toggle(desktop, "tau.signals", false);
    await settled();
    expect(host.config.disabledExtensions).toEqual(["tau.signals"]);
    expect(phone.registry.isActive("tau.signals")).toBe(false);
    expect(phone.mounted.count).toBe(0);
    expect(extensionCatalog({ summaries: phone.registry.getExtensionSummaries(), disabled: phone.preferences.getSnapshot().disabledExtensions })[0]?.state).toBe("off");

    toggle(phone, "tau.signals", true);
    await settled();
    expect(host.config.disabledExtensions).toEqual([]);
    expect(desktop.registry.isActive("tau.signals")).toBe(true);
    expect([desktop.mounted.count, phone.mounted.count]).toEqual([1, 1]);
  });

  it("takes the host's list at the first answer, whatever this device remembered", async () => {
    const { connect } = sharedHost({ disabledExtensions: ["tau.signals"] });
    const phone = device(connect());
    expect(phone.registry.isActive("tau.signals")).toBe(true);
    await settled();
    expect(phone.registry.isActive("tau.signals")).toBe(false);
  });

  it("keeps a change of its own the host has not answered yet", async () => {
    const store = new PreferencesStore();
    let config: TauConfig = {};
    store.bindHost(createFakeHostClient({ getConfig: async () => config, updateConfig: async () => ({}) }));
    await store.syncFromHost();
    store.setExtensionEnabled("acme.one", false);
    store.setExtensionEnabled("acme.two", false);
    // An answer from between the two writes: only the first has landed.
    config = { disabledExtensions: ["acme.one"] };
    await store.syncFromHost();
    expect(store.getSnapshot().disabledExtensions).toEqual(["acme.one", "acme.two"]);
    config = { disabledExtensions: ["acme.two"] };
    await store.syncFromHost();
    expect(store.getSnapshot().disabledExtensions).toEqual(["acme.two"]);
  });

  it("leaves a kit waiting for approval off when the list lets it go", async () => {
    const { connect } = sharedHost({ disabledExtensions: ["acme.waiting"] });
    const phone = device(connect());
    const waiting: DesktopExtension = { id: "acme.waiting", name: "Waiting", granted: false, activate: vi.fn() };
    phone.registry.addKnown(waiting);
    await settled();
    phone.preferences.applyConfig({ disabledExtensions: [] });
    expect(phone.registry.isActive("acme.waiting")).toBe(false);
    expect(waiting.activate).not.toHaveBeenCalled();
  });

  it("shows the host's choice on the phone's Extensions page, and no switch to change it on a Read-only device", async () => {
    const { connect } = sharedHost();
    const desktop = device(connect());
    const phone = device(connect({ readOnly: true }));
    const snapshot = { cwd: "/work/app", workspaceId: "ws-app", models: [], thinkingLevels: [] } as unknown as HostSnapshot;
    render(<HostClientProvider client={phone.client}>
      <TestProviders preferences={phone.preferences}>
        <SettingsScreen page="extensions" snapshot={snapshot} registry={phone.registry} projects={[]} onSetPage={vi.fn()} onSetModel={vi.fn()} onSetThinking={vi.fn()} onClose={vi.fn()} onNotify={vi.fn()} />
      </TestProviders>
    </HostClientProvider>);
    const page = screen.getByRole("dialog", { name: "Settings" });
    const row = await within(page).findByRole("switch", { name: "Turn off Signals" });
    expect(row.getAttribute("aria-checked")).toBe("true");
    expect((row as HTMLButtonElement).disabled).toBe(true);

    toggle(desktop, "tau.signals", false);
    await settled();
    await waitFor(() => expect(within(page).getByRole("switch", { name: "Turn on Signals" }).getAttribute("aria-checked")).toBe("false"));
    fireEvent.click(within(page).getByRole("switch", { name: "Turn on Signals" }));
    await settled();
    expect(phone.preferences.getSnapshot().disabledExtensions).toEqual(["tau.signals"]);
  });
});
