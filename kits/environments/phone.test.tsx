// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformEnvironments, UiDiscoveredHosts, UiEnvironment, UiEnvironments, WorkbenchActions } from "tau";
import { createKitHarness, ThreadStore, ThreadStoreContext } from "../../src/renderer/test-support/kit-harness.js";
import { environmentsExtension } from "./desktop.js";
import { notReachable } from "./list-head.js";

afterEach(cleanup);

const machine = (id: string, patch: Partial<UiEnvironment> = {}): UiEnvironment => ({
  id, name: id, local: false, status: "connected", threads: [], threadCount: 0, projects: [], ...patch,
});

// A phone knows no machine of its own: every one is a paired host.
const mac = machine("mac");
const rex = machine("rex", {
  threads: [{ id: "r1", path: "/r/1", title: "Build on rex", projectName: "shop", modifiedAt: 5, running: true }, { id: "r2", path: "/r/2", title: "Old", projectName: "shop", modifiedAt: 1, settled: true }],
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
  const { registry } = createKitHarness(undefined, "compact", { environments: fake.environments });
  registry.activate(environmentsExtension);
  return { ...fake, registry };
}

describe("Machines Kit on a phone", () => {
  it("adds the other hosts' threads to the thread list, and names the host on screen while there are several", () => {
    const { registry, set } = phone({ shown: "mac", environments: [mac, rex], secureStorage: true });
    const [source] = registry.getThreadListSources();
    expect(source!.id).toBe("environments.threads");
    const stop = source!.subscribe(() => undefined);
    expect(source!.threads().map((entry) => [entry.key, entry.running ?? false, entry.settled ?? false])).toEqual([["machine:rex:r1", true, false], ["machine:rex:r2", false, true]]);
    expect(source!.here!()?.name).toBe("mac");
    set({ shown: "mac", environments: [mac], secureStorage: true });
    expect(source!.here!()).toBeUndefined();
    stop();
    // No Settings page and no title-bar chip: the phone manages its hosts in its own host list.
    expect(registry.getSettingsPages()).toEqual([]);
    expect(registry.getRegions("draft-actions").map((region) => region.id)).toEqual(["environments.run-on-sheet"]);
  });

  it("offers every paired host in a sheet, the one out of reach with its reason, and moves the draft to the one picked", () => {
    const { registry, environments } = phone({ shown: "mac", environments: [mac, rex, box], secureStorage: true });
    const Control = registry.getRegions("draft-actions")[0]!.Component;
    const store = new ThreadStore();
    const setComposerDraft = vi.fn();
    render(<ThreadStoreContext.Provider value={store}><Control actions={fakeActions({ activeThread: () => ({ draftPending: true, cwd: "/Users/me/shop" }) as never, composerDraft: () => "Fix checkout", setComposerDraft })} /></ThreadStoreContext.Provider>);
    fireEvent.click(screen.getByRole("button", { name: "Run on mac" }));
    const sheet = screen.getByRole("dialog", { name: "Run on" });
    const rows = [...sheet.querySelectorAll<HTMLButtonElement>(".run-on-row")];
    expect(rows.map((row) => [row.textContent, row.getAttribute("aria-pressed"), row.disabled])).toEqual([
      ["maconline · idle", "true", false],
      ["rexonline · 1 running", "false", false],
      [expect.stringMatching(/^boxOffline · last seen/u), "false", true],
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
    render(<Head actions={fakeActions()} />);
    const notices = screen.getAllByRole("status");
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

  it("words the last sighting as the design does", () => {
    const now = 1_000_000_000;
    expect(notReachable(machine("MacBook Pro", { status: "offline", lastSeenAt: now - 12 * 60_000 }), now)).toBe("MacBook Pro not reachable · last seen 12 min ago");
    expect(notReachable(machine("box", { status: "offline", lastSeenAt: now - 3 * 3_600_000 }), now)).toBe("box not reachable · last seen 3 h ago");
    expect(notReachable(machine("box", { status: "offline" }), now)).toBe("box not reachable");
  });
});
