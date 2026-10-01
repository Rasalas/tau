// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformEnvironments, UiDiscoveredHosts, UiEnvironment, UiEnvironments, WorkbenchActions } from "tau";
import { createKitHarness, createMemoryStorage, setClientStorage, ThreadStore, ThreadStoreContext } from "../../src/renderer/test-support/kit-harness.js";
import { createRailSection, environmentsExtension } from "./desktop.js";
import { notReachable } from "./list-head.js";
import { WORKSPACE_STORE_SERVICE, type DraftMachineSource } from "./protocol.js";

afterEach(cleanup);

const machine = (id: string, patch: Partial<UiEnvironment> = {}): UiEnvironment => ({
  id, name: id, local: false, status: "connected", threads: [], threadCount: 0, projects: [], ...patch,
});

// A phone knows no machine of its own: every one is a paired host.
const mac = machine("mac");
const rex = machine("rex", {
  threads: [{ id: "r1", path: "/r/1", title: "Build on rex", projectName: "shop", modifiedAt: 5, running: true, waiting: true }, { id: "r2", path: "/r/2", title: "Old", projectName: "shop", modifiedAt: 1, settled: true }],
  threadCount: 2,
  projects: [{ name: "other", lastOpenedAt: 9, workspaceId: "ws-other" }, { name: "shop", lastOpenedAt: 1, workspaceId: "ws-shop" }],
});
const box = machine("box", { status: "offline", lastSeenAt: 0 });
const attic = machine("attic", { status: "refused" });

function fakeEnvironments(initial: UiEnvironments) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const environments = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    pair: vi.fn(async () => ({ state: "cancelled" as const })),
    cancelPairing: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    open: vi.fn(async () => undefined),
    takeArrival: vi.fn(async () => undefined),
    showLocal: vi.fn(async () => undefined),
    discover: vi.fn(async (): Promise<UiDiscoveredHosts> => ({ hosts: [], serviceType: "" })),
    setPreferences: vi.fn(async () => undefined),
  } satisfies PlatformEnvironments;
  const set = (next: UiEnvironments) => { snapshot = next; act(() => listeners.forEach((listener) => listener())); };
  return { environments, set };
}

function fakeActions(patch: Partial<WorkbenchActions> = {}): WorkbenchActions {
  return new Proxy(patch, { get: (target, key) => (target as Record<string, unknown>)[key as string] ?? vi.fn() }) as WorkbenchActions;
}

function phone(list: UiEnvironments) {
  const fake = fakeEnvironments(list);
  const { registry } = createKitHarness(async (_extensionId, command) => command === "agents" ? { available: false, machines: [] } : undefined, "compact", { environments: fake.environments });
  // Workspace Kit's store, as far as "Run on" goes: it keeps the machines' source for its pill.
  let runOn: DraftMachineSource | undefined;
  registry.activate({ id: "workspace-stub", name: "Workspace", activate: (context) => {
    context.provideService(WORKSPACE_STORE_SERVICE, { registerDraftMachine: (source: DraftMachineSource) => { runOn = source; return () => undefined; } });
  } });
  registry.activate(environmentsExtension);
  return { ...fake, registry, runOn: () => runOn! };
}

describe("Machines Kit on a phone", () => {
  it("adds the other hosts' threads to the thread list, and names the host on screen while there are several", () => {
    const { registry, set } = phone({ shown: "mac", environments: [mac, rex], secureStorage: true });
    const [source] = registry.getThreadListSources();
    expect(source!.id).toBe("environments.threads");
    const stop = source!.subscribe(() => undefined);
    expect(source!.threads().map((entry) => [entry.key, entry.running ?? false, entry.waiting ?? false, entry.settled ?? false])).toEqual([["machine:rex:r1", true, true, false], ["machine:rex:r2", false, false, true]]);
    expect(source!.here!()?.name).toBe("mac");
    set({ shown: "mac", environments: [mac], secureStorage: true });
    expect(source!.here!()).toBeUndefined();
    stop();
    // Its own Machines page (1t), no title-bar chip: the phone pairs in its own host list.
    expect(registry.getSettingsPages().map((page) => page.id)).toEqual(["environments.machines"]);
    expect(registry.getRegions("draft-actions").map((region) => region.id)).toEqual(["environments.arrival"]);
  });

  it("offers every paired host in Run on's sheet, the one out of reach with its reason, and moves the draft to the one picked", () => {
    const { runOn, environments } = phone({ shown: "mac", environments: [mac, rex, box], secureStorage: true });
    const { Section } = runOn();
    const store = new ThreadStore();
    const setComposerDraft = vi.fn();
    render(<ThreadStoreContext.Provider value={store}><Section touch actions={fakeActions({ activeThread: () => ({ draftPending: true, cwd: "/Users/me/shop" }) as never, composerDraft: () => "Fix checkout", setComposerDraft })} /></ThreadStoreContext.Provider>);
    const rows = within(screen.getByRole("group", { name: "Machines" })).getAllByRole("button") as HTMLButtonElement[];
    expect(rows.map((row) => [row.textContent, row.getAttribute("aria-pressed"), row.disabled, row.dataset.touch])).toEqual([
      ["maconline · idle", "true", false, "true"],
      ["rexonline · 1 running", "false", false, "true"],
      [expect.stringMatching(/^boxOffline · last seen/u), "false", true, "true"],
    ]);
    // Opening the sheet asks the machine out of reach again.
    expect(environments.retry).toHaveBeenCalledWith("box");
    fireEvent.click(rows[1]!);
    expect(setComposerDraft).toHaveBeenCalledWith("");
    // The project of the same name there, not the one it used last.
    expect(environments.open).toHaveBeenCalledWith("rex", { newThread: { draft: "Fix checkout", workspaceId: "ws-shop" } });
  });

  it("says over the list which host it cannot reach, with Retry, or Pair again for one that refused it", async () => {
    const { registry, environments } = phone({ shown: "mac", environments: [mac, rex, box, attic], secureStorage: true });
    const Head = registry.getRegions("thread-list-head").find((region) => region.id === "environments.list-head")!.Component;
    render(<ThreadStoreContext.Provider value={new ThreadStore()}><Head actions={fakeActions()} /></ThreadStoreContext.Provider>);
    const notices = await screen.findAllByRole("status");
    expect(notices.map((notice) => notice.textContent)).toEqual([
      expect.stringMatching(/^attic no longer accepts this devicePair again$/u),
      expect.stringMatching(/^box not reachable · last seen (.+ago|on .+)Retry$/u),
    ]);
    fireEvent.click(within(notices[1]!).getByRole("button", { name: "Retry box" }));
    expect(environments.retry).toHaveBeenCalledWith("box");
    fireEvent.click(within(notices[0]!).getByRole("button", { name: "Pair again" }));
    expect(environments.open).toHaveBeenCalledWith("attic");
    // What the page was sent here for is asked for once.
    expect(environments.takeArrival).toHaveBeenCalledTimes(1);
  });

  it("offers a machine that answers when the one on screen is gone, once (2p)", async () => {
    const { registry, environments } = phone({ shown: "box", environments: [box, rex], secureStorage: true });
    const Head = registry.getRegions("thread-list-head").find((region) => region.id === "environments.list-head")!.Component;
    render(<ThreadStoreContext.Provider value={new ThreadStore()}><Head actions={fakeActions()} /></ThreadStoreContext.Provider>);
    const card = (await screen.findByText("Showing what the phone last saw")).closest("div")!;
    fireEvent.click(within(card).getByRole("button", { name: "Use rex" }));
    expect(environments.open).toHaveBeenCalledWith("rex");
    fireEvent.click(within(card).getByRole("button", { name: "OK" }));
    expect(screen.queryByText("Showing what the phone last saw")).toBeNull();
  });

  it("lists the paired machines in Settings, shows another on a tap and pairs in the app's own screen (1t)", () => {
    const { registry, environments } = phone({ shown: "mac", environments: [mac, rex, box], secureStorage: true });
    const page = registry.getSettingsPages().find((entry) => entry.id === "environments.machines")!;
    render(<page.Component onNotify={vi.fn()} onOpenSettings={vi.fn()} />);
    const rows = screen.getByRole("group", { name: "Machines" });
    expect(within(rows).getByRole("button", { name: /^rex/u }).textContent).toContain("online · 1 running · other, shop");
    fireEvent.click(within(rows).getByRole("button", { name: /^rex/u }));
    expect(environments.open).toHaveBeenCalledWith("rex");
    fireEvent.click(within(rows).getByRole("button", { name: /^box/u }));
    expect(environments.retry).toHaveBeenCalledWith("box");
    fireEvent.click(screen.getByRole("button", { name: "Pair a machine" }));
    expect(environments.pair).toHaveBeenCalled();
  });

  it("goes on placing a new thread's draft after the list that took it gave way to the draft, with the draft's own actions", async () => {
    setClientStorage(createMemoryStorage());
    const { environments } = fakeEnvironments({ shown: "rex", environments: [mac, rex], secureStorage: true });
    environments.takeArrival.mockResolvedValueOnce({ newThread: { draft: "Fix checkout", workspaceId: "ws-shop" } } as never);
    let text = "";
    const Arrival = createRailSection(environments, async () => undefined, { outlivesMount: true });
    // As in the workbench, each render's actions read that render's state: the list's never see the draft.
    const listActions = fakeActions({ activeThread: () => undefined as never, newSession: vi.fn(() => { draftView.rerender(<Arrival actions={draftActions} />); }) });
    const draftActions = fakeActions({
      activeThread: () => ({ draftPending: true, workspaceId: "ws-shop" }) as never,
      composerDraft: () => text,
      setComposerDraft: vi.fn((next: string) => { text = next; }),
    });
    const list = render(<Arrival actions={listActions} />);
    list.unmount();
    const draftView = render(<span />);
    await vi.waitFor(() => expect(text).toBe("Fix checkout"));
    expect(listActions.newSession).toHaveBeenCalledWith({ workspace: "ws-shop" });
    setClientStorage(undefined);
  });

  it("words the last sighting as the design does", () => {
    const now = 1_000_000_000;
    expect(notReachable(machine("MacBook Pro", { status: "offline", lastSeenAt: now - 12 * 60_000 }), now)).toBe("MacBook Pro not reachable · last seen 12 min ago");
    expect(notReachable(machine("box", { status: "offline", lastSeenAt: now - 3 * 3_600_000 }), now)).toBe("box not reachable · last seen 3 h ago");
    expect(notReachable(machine("box", { status: "offline" }), now)).toBe("box not reachable");
  });
});
