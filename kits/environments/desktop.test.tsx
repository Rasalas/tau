// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscoveredHost, EnvironmentPairResult, PlatformEnvironments, UiDiscoveredHosts, UiEnvironment, UiEnvironments, WorkbenchActions } from "tau";
import { createKitHarness, createMemoryStorage, setClientStorage } from "../../src/renderer/test-support/kit-harness.js";
import { ARRIVAL_KEY, createRailSection, environmentsExtension } from "./desktop.js";
import { followArrival, otherMachines, readPendingArrival, statusText, unavailableReason } from "./machines.js";
import { createMachinesRailSection, createShownMachine } from "./rail.js";
import { createRunOnControl } from "./run-on.js";
import { createMachinesPage } from "./settings.js";
import { WORKSPACE_STORE_SERVICE } from "./protocol.js";

afterEach(cleanup);

const machine = (id: string, patch: Partial<UiEnvironment> = {}): UiEnvironment => ({
  id, name: id, local: false, status: "connected", threads: [], threadCount: 0, projects: [], ...patch,
});

const laptop = machine("laptop", { local: true, threads: [{ id: "l1", path: "/l/1", title: "Local work", projectName: "tau", modifiedAt: 0 }], threadCount: 1 });
const studio = machine("studio", {
  roundTripMs: 4,
  threads: [
    { id: "s1", path: "/s/1", title: "Fix the build", projectName: "api", modifiedAt: 0, running: true },
    { id: "s2", path: "/s/2", title: "Write docs", projectName: "api", modifiedAt: 0 },
  ],
  threadCount: 2,
  projects: [{ name: "api", lastOpenedAt: 1, workspaceId: "ws-api" }],
});
const attic = machine("attic", { status: "offline", lastSeenAt: 0, threads: [{ id: "a1", path: "/a/1", title: "Old idea", projectName: "misc", modifiedAt: 0 }] });

function fakeEnvironments(initial: UiEnvironments) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const environments = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    pair: vi.fn(async (): Promise<EnvironmentPairResult> => ({ state: "added", environment: studio })),
    cancelPairing: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    open: vi.fn(async () => undefined),
    takeArrival: vi.fn(async () => undefined),
    showLocal: vi.fn(async () => undefined),
    discover: vi.fn(async (): Promise<UiDiscoveredHosts> => ({ hosts: [], serviceType: "_tau-test._tcp" })),
    setPreferences: vi.fn(async () => undefined),
  } satisfies PlatformEnvironments;
  const set = (next: UiEnvironments) => { snapshot = next; act(() => listeners.forEach((listener) => listener())); };
  return { environments, set };
}

function fakeActions(patch: Partial<WorkbenchActions> = {}): WorkbenchActions {
  return new Proxy(patch, { get: (target, key) => (target as Record<string, unknown>)[key as string] ?? vi.fn() }) as WorkbenchActions;
}

describe("Machines Kit", () => {
  it("draws nothing in a client that has no window process", () => {
    const { registry } = createKitHarness();
    registry.activate(environmentsExtension);
    expect(registry.getSettingsPages()).toEqual([]);
    expect(registry.getComposerControls()).toEqual([]);
  });

  it("adds its page, command and chip, and a rail section to Workspace Kit's rail", () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop], secureStorage: true });
    const { registry } = createKitHarness(undefined, undefined, { environments });
    const registered = vi.fn(() => () => undefined);
    registry.activate({ id: "workspace-stub", name: "Workspace", activate: (context) => { context.provideService(WORKSPACE_STORE_SERVICE, { registerRailSection: registered }); } });
    registry.activate(environmentsExtension);
    expect(registry.getSettingsPages().map((page) => page.id)).toEqual(["environments.machines"]);
    expect(registry.getComposerControls().map((control) => control.id)).toEqual(["environments.run-on"]);
    expect(registry.getCommands().some((command) => command.id === "environments.add")).toBe(true);
    expect(registered).toHaveBeenCalledTimes(1);
    registry.deactivate(environmentsExtension.id);
    expect(registry.getSettingsPages()).toEqual([]);
  });
});

describe("the other machines in the rail", () => {
  it("stays out of the way while this is the only machine", () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop], secureStorage: true });
    const Section = createMachinesRailSection(environments);
    const { container } = render(<Section actions={fakeActions()} />);
    expect(container.innerHTML).toBe("");
  });

  it("lists each other machine with its threads, and opens a thread there", () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop, studio, attic], secureStorage: true });
    const Section = createMachinesRailSection(environments);
    render(<Section actions={fakeActions()} />);
    expect(screen.getByRole("button", { name: "studio" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Connected · 4 ms" })).toBeTruthy();
    expect(screen.getByLabelText("Working")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fix the build on studio" }));
    expect(environments.open).toHaveBeenCalledWith("studio", { thread: { path: "/s/1" } });
  });

  it("keeps an offline machine's threads visible but closed, and offers to try again", () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop, attic], secureStorage: true });
    const Section = createMachinesRailSection(environments);
    render(<Section actions={fakeActions()} />);
    const row = screen.getByRole("button", { name: "Old idea on attic" });
    expect(row.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(row);
    expect(environments.open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try attic again" }));
    expect(environments.retry).toHaveBeenCalledWith("attic");
  });

  it("lists this machine among the others while the window shows another", () => {
    const { environments } = fakeEnvironments({ shown: "studio", environments: [laptop, studio], secureStorage: true });
    const Section = createMachinesRailSection(environments);
    render(<Section actions={fakeActions()} />);
    fireEvent.click(screen.getByRole("button", { name: "Local work on laptop" }));
    expect(environments.open).toHaveBeenCalledWith("laptop", { thread: { path: "/l/1" } });
  });
});

describe("the title bar", () => {
  it("names the machine the window shows, and nothing while it shows this one", () => {
    const here = fakeEnvironments({ shown: "laptop", environments: [laptop, studio], secureStorage: true });
    const Here = createShownMachine(here.environments);
    const { container } = render(<Here actions={fakeActions()} />);
    expect(container.innerHTML).toBe("");
    cleanup();
    const there = fakeEnvironments({ shown: "studio", environments: [laptop, studio], secureStorage: true });
    const There = createShownMachine(there.environments);
    render(<There actions={fakeActions()} />);
    fireEvent.click(screen.getByRole("button", { name: "Showing studio" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Back to laptop/u }));
    expect(there.environments.showLocal).toHaveBeenCalledTimes(1);
  });
});

describe("Run on", () => {
  it("moves a draft and its text to another machine, into its latest project", () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop, studio, attic], secureStorage: true });
    const Control = createRunOnControl(environments);
    const setComposerDraft = vi.fn();
    const actions = fakeActions({ activeThread: () => ({ draftPending: true }), composerDraft: () => "Refactor the parser", setComposerDraft });
    render(<Control actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Run on laptop" }));
    const offline = screen.getByRole("menuitem", { name: /attic/u });
    expect(offline.getAttribute("aria-disabled") ?? String((offline as HTMLButtonElement).disabled)).toMatch(/true/u);
    fireEvent.click(screen.getByRole("menuitem", { name: /studio/u }));
    expect(environments.open).toHaveBeenCalledWith("studio", { newThread: { draft: "Refactor the parser", workspaceId: "ws-api" } });
    expect(setComposerDraft).toHaveBeenCalledWith("");
  });

  it("does not start a thread on a machine that paired this computer Read only, and says why", () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop, { ...studio, readOnly: true }], secureStorage: true });
    const Control = createRunOnControl(environments);
    render(<Control actions={fakeActions({ activeThread: () => ({ draftPending: true }), composerDraft: () => "x" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Run on laptop" }));
    const item = screen.getByRole("menuitem", { name: /studio/u });
    expect(item.getAttribute("aria-disabled") ?? String((item as HTMLButtonElement).disabled)).toMatch(/true/u);
    expect(item.textContent).toMatch(/Read only: studio lets this computer look/u);
    fireEvent.click(item);
    expect(environments.open).not.toHaveBeenCalled();
  });

  it("is not offered for a started thread, nor with one machine", () => {
    const one = fakeEnvironments({ shown: "laptop", environments: [laptop], secureStorage: true });
    const Control = createRunOnControl(one.environments);
    const { container, rerender } = render(<Control actions={fakeActions({ activeThread: () => ({ draftPending: true }) })} />);
    expect(container.innerHTML).toBe("");
    const two = fakeEnvironments({ shown: "laptop", environments: [laptop, studio], secureStorage: true });
    const Started = createRunOnControl(two.environments);
    rerender(<Started actions={fakeActions({ activeThread: () => ({ draftPending: false, sessionId: "s" }) })} snapshot={{ messages: [{ id: "m" }], isStreaming: false } as never} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("Settings → Machines", () => {
  it("adds a machine and shows the code to compare while its owner decides", async () => {
    const { environments, set } = fakeEnvironments({ shown: "laptop", environments: [laptop], secureStorage: true });
    let finish: (value: Awaited<ReturnType<PlatformEnvironments["pair"]>>) => void = () => undefined;
    environments.pair.mockImplementation(() => new Promise<EnvironmentPairResult>((resolve) => { finish = resolve; }));
    const Page = createMachinesPage(environments);
    render(<Page />);
    fireEvent.change(screen.getByLabelText("Pairing link or address"), { target: { value: "studio.local:7788" } });
    fireEvent.click(screen.getByRole("button", { name: "Add machine" }));
    expect(environments.pair).toHaveBeenCalledWith({ text: "studio.local:7788" });
    set({ shown: "laptop", environments: [laptop], secureStorage: true, pairing: { address: "wss://studio.local:7788/", state: "waiting", verification: "482913" } });
    expect(screen.getByText("482 913")).toBeTruthy();
    await act(async () => { finish({ state: "added", environment: studio }); });
    expect(screen.getByText(/studio was added/u)).toBeTruthy();
  });

  it("says so when the other owner declines", async () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop], secureStorage: true });
    environments.pair.mockResolvedValue({ state: "denied" });
    const Page = createMachinesPage(environments);
    render(<Page />);
    fireEvent.change(screen.getByLabelText("Pairing link or address"), { target: { value: "studio.local" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add machine" })); });
    expect(screen.getByRole("status").textContent).toMatch(/declined/u);
  });

  it("finds machines on this network and adds one with its record's pin", async () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop, studio], secureStorage: true });
    const host = (id: string, name: string, patch: Partial<DiscoveredHost> = {}): DiscoveredHost => ({
      name, hostId: id, fingerprint: "AB:".repeat(31) + "AB", port: 47788, addresses: ["192.168.1.9"], endpoints: [{ url: "https://192.168.1.9:47788/", kind: "lan" }], ...patch,
    });
    environments.discover.mockResolvedValue({ serviceType: "_tau-test._tcp", hosts: [host("attic-id", "Attic"), host("studio", "Studio"), host("laptop", "Laptop", { self: true })] });
    const Page = createMachinesPage(environments);
    render(<Page />);
    // Nothing is looked for until asked: looking is what makes macOS ask about the local network.
    expect(environments.discover).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Find Machines" })); });
    expect(screen.getByText("Added")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Add [A-Z]/u }).map((button) => button.getAttribute("aria-label"))).toEqual(["Add Attic"]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add Attic" })); });
    expect(environments.pair).toHaveBeenCalledWith({ nearby: "attic-id" });
    expect(screen.getByText(/studio was added/u)).toBeTruthy();
  });

  it("keeps the choice to show the last machine again at start", () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop], secureStorage: true });
    const Page = createMachinesPage(environments);
    render(<Page />);
    fireEvent.click(screen.getByRole("switch", { name: "Show the last machine again" }));
    expect(environments.setPreferences).toHaveBeenCalledWith({ reopenShown: true });
  });

  it("removes a machine after asking", () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop, studio], secureStorage: true });
    const Page = createMachinesPage(environments);
    render(<Page />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" }).at(-1)!);
    expect(environments.remove).toHaveBeenCalledWith("studio");
  });
});

describe("a machine's status", () => {
  it("reads as the dot's tooltip, and says why its threads cannot open", () => {
    const now = 3 * 60 * 60_000;
    expect(statusText(studio, now)).toBe("Connected · 4 ms");
    expect(statusText(attic, now)).toBe("Offline · last seen 3h ago");
    expect(unavailableReason(attic, now)).toBe("attic is offline (last seen 3h ago).");
    expect(unavailableReason(studio, now)).toBeUndefined();
    expect(otherMachines({ shown: "studio", environments: [studio, attic, laptop], secureStorage: true }).map((entry) => entry.id)).toEqual(["laptop", "attic"]);
  });
});

describe("arriving on a machine", () => {
  const wait = async () => undefined;

  it("opens the thread once the page knows it", async () => {
    const switchSession = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await followArrival({ thread: { path: "/s/1" } }, { actions: fakeActions({ switchSession }), wait })).toBe(true);
    expect(switchSession).toHaveBeenCalledTimes(2);
  });

  it("opens a draft in the project it was sent to, with the text", async () => {
    let pending = false;
    const newSession = vi.fn(() => { pending = true; });
    let text = "";
    // The first text is lost to the composer mounting, as in the app.
    const setComposerDraft = vi.fn((value: string) => { if (setComposerDraft.mock.calls.length > 1) text = value; });
    const actions = fakeActions({ newSession, setComposerDraft, composerDraft: () => text, activeThread: () => pending ? { draftPending: true, workspaceId: "ws-api" } : undefined });
    expect(await followArrival({ newThread: { draft: "hello", workspaceId: "ws-api" } }, { actions, wait })).toBe(true);
    expect(newSession).toHaveBeenCalledWith({ workspace: "ws-api" });
    expect(setComposerDraft).toHaveBeenCalledTimes(2);
    expect(text).toBe("hello");
  });
});

describe("a draft sent to a machine that shows its first-start setup", () => {
  afterEach(() => setClientStorage(undefined));

  it("stops while the workbench is away and does not start a thread behind the setup", async () => {
    const newSession = vi.fn();
    const actions = fakeActions({ newSession, activeThread: () => undefined });
    expect(await followArrival({ newThread: { draft: "hello" } }, { actions, wait: async () => undefined, shown: () => false })).toBe(false);
    expect(newSession).not.toHaveBeenCalled();
  });

  it("keeps the draft through the setup and puts it in the composer after", async () => {
    const storage = createMemoryStorage();
    setClientStorage(storage);
    const { environments } = fakeEnvironments({ shown: "studio", environments: [laptop, studio], secureStorage: true });
    environments.takeArrival.mockResolvedValueOnce({ newThread: { draft: "hello", workspaceId: "ws-api" } } as never);
    let setupDone = false;
    let pending = false;
    let text = "";
    const actions = fakeActions({
      newSession: vi.fn(() => { if (setupDone) pending = true; }),
      activeThread: () => pending ? { draftPending: true, workspaceId: "ws-api" } as never : undefined,
      setComposerDraft: vi.fn((value: string) => { text = value; }),
      composerDraft: () => text,
      focusComposer: vi.fn(),
    });
    let release: () => void = () => undefined;
    const pause = () => new Promise<void>((resolve) => { release = resolve; });
    const Rail = createRailSection(environments, pause);
    const first = render(<Rail actions={actions} />);
    await vi.waitFor(() => expect(storage.get(ARRIVAL_KEY)).toBeTruthy());
    // The setup takes the window: the workbench and its rail go.
    first.unmount();
    await act(async () => { release(); });
    expect(readPendingArrival(storage.get(ARRIVAL_KEY))?.target).toEqual({ newThread: { draft: "hello", workspaceId: "ws-api" } });

    setupDone = true;
    render(<Rail actions={actions} />);
    await vi.waitFor(() => { release(); expect(text).toBe("hello"); });
    await vi.waitFor(() => { release(); expect(storage.get(ARRIVAL_KEY)).toBeNull(); });
    expect(environments.takeArrival).toHaveBeenCalledTimes(1);
  });

  it("follows once per mount, not once per render", async () => {
    setClientStorage(createMemoryStorage());
    const { environments } = fakeEnvironments({ shown: "studio", environments: [laptop, studio], secureStorage: true });
    environments.takeArrival.mockResolvedValueOnce({ thread: { path: "/s/1" } } as never);
    const switchSession = vi.fn(() => new Promise<boolean>(() => undefined));
    const Rail = createRailSection(environments, async () => undefined);
    const view = render(<Rail actions={fakeActions({ switchSession })} />);
    await vi.waitFor(() => expect(switchSession).toHaveBeenCalledTimes(1));
    for (let index = 0; index < 5; index += 1) view.rerender(<Rail actions={fakeActions({ switchSession })} />);
    await act(async () => undefined);
    expect(switchSession).toHaveBeenCalledTimes(1);
  });

  it("reads back only what it wrote", () => {
    expect(readPendingArrival(JSON.stringify({ machine: "m", target: { thread: { path: "/p" } } }))).toEqual({ machine: "m", target: { thread: { path: "/p" } } });
    expect(readPendingArrival("{")).toBeUndefined();
    expect(readPendingArrival(JSON.stringify({ target: { thread: { path: "/p" } } }))).toBeUndefined();
  });
});

describe("Run on for a thread nothing was sent in", () => {
  it("is offered, since the thread has not started anywhere yet", () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop, studio], secureStorage: true });
    const Control = createRunOnControl(environments);
    render(<Control actions={fakeActions({ activeThread: () => ({ draftPending: false, sessionId: "s" }) })} snapshot={{ messages: [], isStreaming: false } as never} />);
    expect(screen.getByRole("button", { name: "Run on laptop" })).toBeTruthy();
  });
});
