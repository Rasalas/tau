// @vitest-environment jsdom
import type { ReactElement } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiscoveredHost, EnvironmentPairResult, HostReadiness, HostResources, PlatformEnvironments, UiDiscoveredHosts, UiEnvironment, UiEnvironments, WorkbenchActions } from "tau";
import { createKitHarness, createMemoryStorage, HostClientProvider, RendererServicesProvider, setClientStorage } from "../../src/renderer/test-support/kit-harness.js";
import { autoRunOn, createAutoRunOnHook, RUN_ON_KEY } from "./auto.js";
import { ARRIVAL_KEY, createRailSection, environmentsExtension } from "./desktop.js";
import { followArrival, otherMachines, readPendingArrival, statusText, unavailableReason } from "./machines.js";
import { agentThreadsSource, createMachineCardRow, createMachineThreads, createShownMachine } from "./rail.js";
import { branchSection, createDraftMachine, createRunOnControl, runOnDetail } from "./run-on.js";
import { createMachinesPage } from "./settings.js";
import { BRANCH_SECTION_SERVICE, REMOTE_AGENT_THREADS_SERVICE, WORKSPACE_STORE_SERVICE } from "./protocol.js";

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

/** The providers a settings row needs; `client` holds the config levels it reads and writes. */
function withSettings(node: ReactElement, client?: unknown) {
  const { preferences } = createKitHarness();
  return <HostClientProvider client={client as never}><RendererServicesProvider services={{ preferences }}>{node}</RendererServicesProvider></HostClientProvider>;
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

  it("adds its page, command and chip, and its threads and arrivals to Workspace Kit's rail", () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop], secureStorage: true });
    const { registry } = createKitHarness(undefined, undefined, { environments });
    const registered = vi.fn(() => () => undefined);
    const listed = vi.fn(() => () => undefined);
    const card = vi.fn(() => () => undefined);
    registry.activate({ id: "workspace-stub", name: "Workspace", activate: (context) => { context.provideService(WORKSPACE_STORE_SERVICE, { registerRailSection: registered, registerRailThreads: listed, registerThreadCardSection: card }); } });
    registry.activate(environmentsExtension);
    expect(registry.getSettingsPages().map((page) => page.id)).toEqual(["environments.machines"]);
    expect(registry.getComposerControls().map((control) => control.id)).toEqual(["environments.run-on"]);
    expect(registry.getCommands().some((command) => command.id === "environments.add")).toBe(true);
    expect(registered).toHaveBeenCalledTimes(1);
    expect(listed).toHaveBeenCalledTimes(1);
    expect(card).toHaveBeenCalledWith(expect.objectContaining({ place: "row", order: 20 }));
    registry.deactivate(environmentsExtension.id);
    expect(registry.getSettingsPages()).toEqual([]);
  });
});

describe("the machine on a rail row's hover card", () => {
  const Row = ({ children }: { icon: unknown; children: ReactElement | string }) => <p>{children}</p>;

  it("names the machine the window shows for its own threads, and leaves another machine's row to name its own", () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop, studio], secureStorage: true });
    const MachineCardRow = createMachineCardRow(environments);
    const view = render(<MachineCardRow external={false} Row={Row as never} />);
    expect(view.container.textContent).toBe("laptop");
    cleanup();
    expect(render(<MachineCardRow external Row={Row as never} />).container.textContent).toBe("");
  });
});

describe("the other machines' threads in the rail", () => {
  const titles = (source: ReturnType<typeof createMachineThreads>) => source.threads().map((thread) => `${thread.session.title} on ${thread.machine.name}`);

  it("lists nothing while this is the only machine", () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop], secureStorage: true });
    expect(createMachineThreads(environments).threads()).toEqual([]);
  });

  it("gives each thread of another machine that machine's mark and a key of its own, and opens it there", () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop, studio, attic], secureStorage: true });
    const source = createMachineThreads(environments);
    expect(titles(source)).toEqual(["Old idea on attic", "Fix the build on studio", "Write docs on studio"]);
    const build = source.threads().find((thread) => thread.session.title === "Fix the build")!;
    expect(build).toMatchObject({ key: "machine:studio:s1", running: true, machine: { name: "studio" } });
    // Grouped by name with this machine's project, never taken for one of its folders.
    expect(build.session).toMatchObject({ projectName: "api", projectPath: "studio:api", path: "/s/1" });
    const listener = vi.fn();
    const stop = source.subscribe(listener);
    build.open(fakeActions());
    expect(environments.open).toHaveBeenCalledWith("studio", { thread: { path: "/s/1" } });
    expect(source.threads().find((thread) => thread.key === "machine:studio:s1")?.opening).toBe(true);
    expect(listener).toHaveBeenCalled();
    stop();
  });

  it("carries the thread's branch, cost and runtime from that machine's index", () => {
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, costUsd: 0.5, turns: 1 };
    const rich = machine("studio", { threads: [{ id: "s9", path: "/s/9", title: "Tune", projectName: "api", modifiedAt: 5, projectLabel: "feat/x", usage, backendKind: "codex", modelProvider: "openai" }] });
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop, rich], secureStorage: true });
    expect(createMachineThreads(environments).threads()[0]?.session).toMatchObject({ projectLabel: "feat/x", usage, backendKind: "codex", modelProvider: "openai", modifiedAt: 5 });
  });

  it("keeps an offline machine's threads listed but closed, with the reason", () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop, attic], secureStorage: true });
    const [idea] = createMachineThreads(environments).threads();
    expect(idea?.unavailable).toMatch(/^attic is offline/u);
  });

  it("looks in on a thread there in a tab here, where the core offers it, and not on an older core", () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop, studio], secureStorage: true });
    const openThread = vi.fn();
    const [build] = createMachineThreads({ ...environments, watchThread: () => () => undefined }).threads();
    build?.lookIn?.(fakeActions({ openThread }));
    expect(openThread).toHaveBeenCalledWith("s1", { pin: true, machine: "studio" });
    expect(environments.open).not.toHaveBeenCalled();
    // An older core has no look-in, and would read the id as this machine's thread.
    expect(createMachineThreads(environments).threads()[0]?.lookIn).toBeUndefined();
  });

  it("answers the same list until something changed", () => {
    const { environments, set } = fakeEnvironments({ shown: "laptop", environments: [laptop, studio], secureStorage: true });
    const source = createMachineThreads(environments);
    const first = source.threads();
    expect(source.threads()).toBe(first);
    set({ shown: "laptop", environments: [laptop, studio, attic], secureStorage: true });
    expect(source.threads()).not.toBe(first);
  });

  it("leaves out the threads this computer's sub-agents run there", () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop, studio], secureStorage: true });
    const { registry } = createKitHarness(undefined, undefined, { environments });
    const listeners = new Set<() => void>();
    let agents = new Set(["s1"]);
    registry.activate({
      id: "agents-stub", name: "Agents",
      activate: (context) => {
        context.provideService(REMOTE_AGENT_THREADS_SERVICE, {
          threadsOn: (id: string) => (id === "studio" ? agents : new Set<string>()),
          subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        });
      },
    });
    registry.activate(environmentsExtension);
    const source = createMachineThreads(environments);
    const stop = source.subscribe(() => undefined);
    expect(titles(source)).toEqual(["Write docs on studio"]);
    // Once the agent's thread there is let go, it is the machine's own again.
    agents = new Set();
    act(() => listeners.forEach((listener) => listener()));
    expect(titles(source)).toEqual(["Fix the build on studio", "Write docs on studio"]);
    stop();
    registry.deactivate(environmentsExtension.id);
    expect(agentThreadsSource.threadsOn("studio")).toBeUndefined();
  });

  it("lists this machine's threads, with its mark, while the window shows another", () => {
    const { environments } = fakeEnvironments({ shown: "studio", environments: [laptop, studio], secureStorage: true });
    const source = createMachineThreads(environments);
    expect(titles(source)).toEqual(["Local work on laptop"]);
    source.threads()[0]?.open(fakeActions());
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

  it("leads every new thread, one machine too, and is not offered for a started thread", () => {
    const one = fakeEnvironments({ shown: "laptop", environments: [laptop], secureStorage: true });
    const Control = createRunOnControl(one.environments);
    const { container, rerender } = render(<Control actions={fakeActions({ activeThread: () => ({ draftPending: true }) })} />);
    fireEvent.click(screen.getByRole("button", { name: "Run on laptop" }));
    expect(screen.getByRole("menuitem", { name: /laptop/u }).textContent).toContain("this machine · idle");
    fireEvent.click(screen.getByRole("button", { name: "Run on laptop" }));
    const two = fakeEnvironments({ shown: "laptop", environments: [laptop, studio], secureStorage: true });
    const Started = createRunOnControl(two.environments);
    rerender(<Started actions={fakeActions({ activeThread: () => ({ draftPending: false, sessionId: "s" }) })} snapshot={{ messages: [{ id: "m" }], isStreaming: false } as never} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("Run on, as in the design", () => {
  afterEach(() => branchSection.set(undefined));

  it("says per machine whether it is this one, online or offline, and how busy", () => {
    expect(runOnDetail(laptop, 0)).toBe("this machine · idle");
    expect(runOnDetail(studio, 0)).toBe("online · 1 running");
    expect(runOnDetail(machine("box"), 0)).toBe("online · idle");
    expect(runOnDetail(attic, 60_000)).toBe(statusText(attic, 60_000));
  });

  it("draws Workspace Kit's Branch section under the machines, for a draft only", () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop, studio], secureStorage: true });
    const { registry } = createKitHarness(undefined, undefined, { environments });
    registry.activate({ id: "workspace-stub", name: "Workspace", activate: (context) => {
      context.provideService(BRANCH_SECTION_SERVICE, { Section: () => <input aria-label="Branch name" /> });
    } });
    registry.activate(environmentsExtension);
    const control = registry.getComposerControls().find((entry) => entry.id === "environments.run-on");
    expect(control?.placement).toBe("lead");
    const Control = control!.Component;
    const draft = fakeActions({ activeThread: () => ({ draftPending: true }) });
    const { rerender } = render(<Control actions={draft} />);
    fireEvent.click(screen.getByRole("button", { name: "Run on laptop" }));
    const field = screen.getByRole("textbox", { name: "Branch name" });
    // Typing stays in the field: the menu's typeahead must not take the keys.
    const key = new KeyboardEvent("keydown", { key: "s", bubbles: true, cancelable: true });
    field.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Run on laptop" }));
    rerender(<Control actions={fakeActions({ activeThread: () => ({ draftPending: false }) })} snapshot={{ messages: [], isStreaming: false } as never} />);
    fireEvent.click(screen.getByRole("button", { name: "Run on laptop" }));
    expect(screen.queryByRole("textbox", { name: "Branch name" })).toBeNull();
  });

  it("names a new thread's machine in the header, and nothing for a running thread", () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop, studio], secureStorage: true });
    const Machine = createDraftMachine(environments);
    const { container, rerender } = render(<Machine actions={fakeActions({ activeThread: () => ({ draftPending: true }) })} />);
    expect(container.textContent).toBe("laptop");
    rerender(<Machine actions={fakeActions({ activeThread: () => ({ draftPending: false, sessionId: "s" }) })} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("Settings → Machines", () => {
  it("adds a machine and shows the code to compare while its owner decides", async () => {
    const { environments, set } = fakeEnvironments({ shown: "laptop", environments: [laptop], secureStorage: true });
    let finish: (value: Awaited<ReturnType<PlatformEnvironments["pair"]>>) => void = () => undefined;
    environments.pair.mockImplementation(() => new Promise<EnvironmentPairResult>((resolve) => { finish = resolve; }));
    const Page = createMachinesPage(environments);
    render(withSettings(<Page />));
    fireEvent.change(screen.getByLabelText("Pairing link or address"), { target: { value: "studio.local:7788" } });
    fireEvent.click(screen.getByRole("button", { name: "Add machine" }));
    expect(environments.pair).toHaveBeenCalledWith({ text: "studio.local:7788" });
    set({ shown: "laptop", environments: [laptop], secureStorage: true, pairing: { address: "wss://studio.local:7788/", state: "waiting", verification: "482913" } });
    expect(screen.getByText("482 913")).toBeTruthy();
    await act(async () => { finish({ state: "added", environment: studio }); });
    expect(screen.getByText(/studio was added/u)).toBeTruthy();
  });

  it("answers Add machine with an empty field: says what to paste and puts the cursor there", () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop], secureStorage: true });
    const Page = createMachinesPage(environments);
    render(withSettings(<Page />));
    const button = screen.getByRole("button", { name: "Add machine" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(environments.pair).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toMatch(/Paste the pairing link/u);
    const field = screen.getByLabelText("Pairing link or address");
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "studio.local" } });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says why Add machine is off where nothing can keep another machine's key", () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop], secureStorage: false });
    const Page = createMachinesPage(environments);
    render(withSettings(<Page />));
    const button = screen.getByRole("button", { name: "Add machine" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.closest("[data-tooltip]")?.getAttribute("data-tooltip")).toMatch(/no encrypted storage/u);
  });

  it("says so when the other owner declines", async () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop], secureStorage: true });
    environments.pair.mockResolvedValue({ state: "denied" });
    const Page = createMachinesPage(environments);
    render(withSettings(<Page />));
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
    render(withSettings(<Page />));
    // Nothing is looked for until asked: looking is what makes macOS ask about the local network.
    expect(environments.discover).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Find machines" })); });
    expect(screen.getByText("Added")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Add [A-Z]/u }).map((button) => button.getAttribute("aria-label"))).toEqual(["Add Attic"]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add Attic" })); });
    expect(environments.pair).toHaveBeenCalledWith({ nearby: "attic-id" });
    expect(screen.getByText(/studio was added/u)).toBeTruthy();
  });

  it("keeps the choice to show the last machine again at start", () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop], secureStorage: true });
    const Page = createMachinesPage(environments);
    render(withSettings(<Page />));
    fireEvent.click(screen.getByRole("switch", { name: "Show the last machine again" }));
    expect(environments.setPreferences).toHaveBeenCalledWith({ reopenShown: true });
  });

  it("removes a machine after asking", () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop, studio], secureStorage: true });
    const Page = createMachinesPage(environments);
    render(withSettings(<Page />));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" }).at(-1)!);
    expect(environments.remove).toHaveBeenCalledWith("studio");
  });
});

describe("Settings → Machines: this computer's agents", () => {
  function agentsHost(machines: Array<{ id: string; name: string; status: "connected" | "refused"; detail?: string }>, answers: Record<string, (input: unknown) => unknown> = {}) {
    let emit: ((payload: unknown) => void) | undefined;
    const host = {
      invoke: vi.fn(async (command: string, input?: unknown) => {
        if (answers[command]) return answers[command](input);
        // Load and readiness stay unanswered unless a test gives them.
        return command === "agents" ? { available: true, machines } : new Promise(() => undefined);
      }),
      onEvent: vi.fn((_name: string, listener: (payload: unknown) => void) => { emit = listener; return () => undefined; }),
    };
    return { host, emit: (payload: unknown) => act(() => emit?.(payload)) };
  }

  it("shows whether they may work on each machine, and turns them on there with a code to compare", async () => {
    const { environments, set } = fakeEnvironments({ shown: "laptop", environments: [laptop, studio], secureStorage: true });
    let finish: (value: { state: "on" }) => void = () => undefined;
    const setAgents = vi.fn(() => new Promise<{ state: "on" }>((resolve) => { finish = resolve; }));
    const { host, emit } = agentsHost([]);
    const Page = createMachinesPage({ ...environments, setAgents }, host);
    render(withSettings(<Page />));
    await act(async () => undefined);
    const toggle = screen.getByRole("switch", { name: "This computer's agents may work on studio" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    // This computer has no switch of its own.
    expect(screen.queryByRole("switch", { name: /work on laptop/u })).toBeNull();
    fireEvent.click(toggle);
    expect(setAgents).toHaveBeenCalledWith("studio", true);
    set({ shown: "laptop", environments: [laptop, studio], secureStorage: true, pairing: { address: "studio", state: "waiting", verification: "112233" } });
    expect(screen.getByText("112 233")).toBeTruthy();
    await act(async () => { finish({ state: "on" }); });
    emit({ available: true, machines: [{ id: "studio", name: "studio", status: "connected", roundTripMs: 7 }] });
    expect(screen.getByRole("switch", { name: "This computer's agents may work on studio" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/agents may work here · connected · 7 ms/u)).toBeTruthy();
  });

  it("says when the other machine refuses them, and turns them off", async () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop, studio], secureStorage: true });
    const setAgents = vi.fn(async () => ({ state: "off" as const }));
    const { host } = agentsHost([{ id: "studio", name: "studio", status: "refused", detail: "revoked there" }]);
    const Page = createMachinesPage({ ...environments, setAgents }, host);
    render(withSettings(<Page />));
    await act(async () => undefined);
    expect(screen.getByText(/refused: revoked there/u)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("switch", { name: "This computer's agents may work on studio" })); });
    expect(setAgents).toHaveBeenCalledWith("studio", false);
  });

  it("asks for them when adding a machine unless told not to, and says when they were not let in", async () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop], secureStorage: true });
    environments.pair.mockResolvedValue({ state: "added", environment: studio, agents: { added: false, message: "studio runs a Tau that pairs no agents." } });
    const { host } = agentsHost([]);
    const Page = createMachinesPage({ ...environments, setAgents: vi.fn() }, host);
    render(withSettings(<Page />));
    await act(async () => undefined);
    fireEvent.change(screen.getByLabelText("Pairing link or address"), { target: { value: "studio.local" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add machine" })); });
    expect(environments.pair).toHaveBeenLastCalledWith({ text: "studio.local", agents: true });
    expect(screen.getByRole("status").textContent).toMatch(/not this computer's agents: studio runs a Tau/u);
    fireEvent.click(screen.getByRole("switch", { name: "This computer's agents may work there" }));
    fireEvent.change(screen.getByLabelText("Pairing link or address"), { target: { value: "attic.local" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add machine" })); });
    expect(environments.pair).toHaveBeenLastCalledWith({ text: "attic.local", agents: false });
  });

  it("shows how busy this computer and each machine its agents reach are, and what each could run", async () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop, studio, attic], secureStorage: true });
    const GB = 1024 ** 3;
    const resources = (input: unknown): HostResources => (input as { machine: string }).machine === "studio"
      ? { sampledAt: 1, cpuCount: 2, cpuUtilization: 0.14, totalMemory: 8 * GB, availableMemory: 5.2 * GB, runningTurns: 1 }
      : { sampledAt: 1, cpuCount: 10, cpuUtilization: 0.5, totalMemory: 32 * GB, availableMemory: 20 * GB, runningTurns: 0, onBattery: true };
    const readiness = (): HostReadiness => ({
      checkedAt: 1,
      runtimes: [
        { kind: "pi", label: "Pi", state: "ready", models: 3, account: "me@example.com" },
        { kind: "codex", label: "Codex", state: "sign-in-required", note: "Codex is not signed in." },
        { kind: "claude-code", label: "Claude Code", state: "not-installed" },
      ],
      git: { version: "2.34.1", mergeTree: false },
      disk: { path: "/home/rex/.tau", free: 41 * GB, total: 100 * GB },
      display: { kind: "invisible", name: ":99" },
    });
    const { host } = agentsHost([
      { id: "studio", name: "studio", status: "connected" },
      { id: "attic", name: "attic", status: "refused", detail: "revoked" },
    ], { resources, readiness });
    const Page = createMachinesPage({ ...environments, setAgents: vi.fn() }, host);
    render(withSettings(<Page />));
    await act(async () => undefined);
    const studioHealth = within(screen.getByRole("group", { name: "How studio is doing" }));
    expect(studioHealth.getByText("2 cores · CPU 14 % · 5.2 GB of 8.0 GB free · 1 turn running")).toBeTruthy();
    expect(studioHealth.getByRole("img", { name: "Pi · ready (3 models) · me@example.com" })).toBeTruthy();
    expect(studioHealth.getByRole("img", { name: "Codex · not signed in" })).toBeTruthy();
    expect(studioHealth.getByRole("img", { name: "Claude Code · not installed" })).toBeTruthy();
    expect(studioHealth.getByText("1 of 3 ready · Git 2.34.1 · 41.0 GB free for worktrees · Invisible display :99")).toBeTruthy();
    expect(studioHealth.getByText(/older than 2\.38/u)).toBeTruthy();
    // This computer answers its own host.
    expect(within(screen.getByRole("group", { name: "How laptop is doing" })).getByText(/10 cores · CPU 50 % · 20.0 GB of 32.0 GB free · idle · on battery/u)).toBeTruthy();
    // A machine whose agents' key is refused is not asked.
    expect(screen.queryByRole("group", { name: "How attic is doing" })).toBeNull();
    expect(host.invoke).not.toHaveBeenCalledWith("resources", { machine: "attic" });
    const asked = host.invoke.mock.calls.length;
    await act(async () => { studioHealth.getByRole("button", { name: "Check again" }).click(); });
    expect(host.invoke.mock.calls.slice(asked)).toEqual([["resources", { machine: "studio" }], ["readiness", { machine: "studio" }]]);
  });

  it("says what it could not learn about a machine", async () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop, studio], secureStorage: true });
    const { host } = agentsHost([{ id: "studio", name: "studio", status: "connected" }], {
      resources: () => { throw new Error("rex is offline."); },
      readiness: () => { throw new Error("readiness: unknown method"); },
    });
    const Page = createMachinesPage({ ...environments, setAgents: vi.fn() }, host);
    render(withSettings(<Page />));
    await act(async () => undefined);
    const health = within(screen.getByRole("group", { name: "How studio is doing" }));
    expect(health.getByText("Load unknown: rex is offline.")).toBeTruthy();
    expect(health.getByText("Readiness unknown: readiness: unknown method")).toBeTruthy();
  });

  it("offers nothing about agents while the page shows another machine", async () => {
    const { environments } = fakeEnvironments({ shown: "studio", environments: [laptop, studio], secureStorage: true });
    const { host } = agentsHost([]);
    const Page = createMachinesPage({ ...environments, shownElsewhere: "studio", setAgents: vi.fn() }, host);
    render(withSettings(<Page />));
    await act(async () => undefined);
    expect(screen.queryByRole("switch", { name: /agents/u })).toBeNull();
    expect(host.invoke).not.toHaveBeenCalled();
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

describe("Run on: Automatic", () => {
  const luna = { provider: "openai-codex", id: "gpt-5.6-luna" };
  const withApi = machine("studio", { projects: [{ name: "api", lastOpenedAt: 1, workspaceId: "ws-api" }] });
  const answer = { machine: "studio", reason: "studio has the most room: 45 (weight 50 · 2 cores · CPU 10 % · 50 % memory free); this computer 40.", machines: [] };
  const chooser = (reply: unknown = answer) => ({ invoke: vi.fn(async () => reply), onEvent: vi.fn(() => () => undefined) });
  const draft = { draftPending: true, cwd: "/work/api", backendKind: "pi", model: luna };
  let storage = createMemoryStorage();
  afterEach(() => { autoRunOn.set(false); setClientStorage(undefined); });
  const useStorage = () => { storage = createMemoryStorage(); setClientStorage(storage); };

  it("is chosen in the chip, stays for the next drafts, and says where the thread would go now", async () => {
    useStorage();
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop, withApi], secureStorage: true });
    const host = chooser();
    const Control = createRunOnControl(environments, host);
    render(<Control actions={fakeActions({ activeThread: () => draft })} />);
    fireEvent.click(screen.getByRole("button", { name: "Run on laptop" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Automatic/u }));
    expect(storage.get(RUN_ON_KEY)).toBe("auto");
    const chip = screen.getByRole("button", { name: "Run on Automatic" });
    await vi.waitFor(() => expect(chip.getAttribute("data-tooltip")).toMatch(/\nNow: studio\. studio has the most room: 45/u));
    expect(host.invoke).toHaveBeenCalledWith("choose-machine", { purpose: "thread", cwd: "/work/api", backend: "pi", model: "openai-codex/gpt-5.6-luna", machines: ["studio"] });
    // Picking a machine ends it.
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole("menuitem", { name: /laptop/u }));
    expect(storage.get(RUN_ON_KEY)).toBeNull();
    expect(screen.getByRole("button", { name: "Run on laptop" })).toBeTruthy();
  });

  it("applies to a new thread's draft only, not to a thread that exists and has no message yet", () => {
    useStorage();
    autoRunOn.set(true);
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop, withApi], secureStorage: true });
    const host = chooser();
    const Control = createRunOnControl(environments, host);
    render(<Control actions={fakeActions({ activeThread: () => ({ draftPending: false, sessionId: "s", cwd: "/work/api" }) })} snapshot={{ messages: [], isStreaming: false } as never} />);
    fireEvent.click(screen.getByRole("button", { name: "Run on laptop" }));
    const item = screen.getByRole("menuitem", { name: /Automatic/u });
    expect(item.getAttribute("aria-disabled") ?? String((item as HTMLButtonElement).disabled)).toMatch(/true/u);
    expect(item.textContent).toMatch(/exists here already/u);
    expect(host.invoke).not.toHaveBeenCalled();
  });

  it("is not offered while the window shows another machine, whose host does not choose for this one", () => {
    useStorage();
    const { environments } = fakeEnvironments({ shown: "studio", environments: [laptop, withApi], secureStorage: true });
    const Control = createRunOnControl({ ...environments, shownElsewhere: "studio" }, chooser());
    render(<Control actions={fakeActions({ activeThread: () => draft })} />);
    fireEvent.click(screen.getByRole("button", { name: "Run on studio" }));
    expect(screen.queryByRole("menuitem", { name: /Automatic/u })).toBeNull();
  });

  const claim = (patch: Record<string, unknown> = {}) => ({
    prompt: "Fix the parser", projectPath: "/work/api", workspaceId: "ws-here", preparing: vi.fn(), alternate: false, model: luna, runtime: "pi", attachments: 0, ...patch,
  });

  it("chooses when the first prompt is sent, and carries it to the machine chosen, which sends it", async () => {
    useStorage();
    autoRunOn.set(true);
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop, withApi], secureStorage: true });
    const host = chooser();
    const hook = createAutoRunOnHook(environments, host);
    const event = claim();
    expect(await hook.claimNewThread!(event, fakeActions())).toBe(true);
    expect(event.preparing).toHaveBeenCalledWith("Choosing a machine…");
    expect(environments.open).toHaveBeenCalledWith("studio", { newThread: { draft: "Fix the parser", send: true, workspaceId: "ws-api", model: luna } });
  });

  it("leaves the prompt here when this computer is chosen, and when it cannot go", async () => {
    useStorage();
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop, withApi], secureStorage: true });
    const notify = vi.fn();
    // Not chosen: nothing is asked.
    const idle = chooser();
    expect(await createAutoRunOnHook(environments, idle).claimNewThread!(claim(), fakeActions({ notify }))).toBe(false);
    expect(idle.invoke).not.toHaveBeenCalled();
    autoRunOn.set(true);
    expect(await createAutoRunOnHook(environments, chooser({ ...answer, machine: null })).claimNewThread!(claim(), fakeActions({ notify }))).toBe(false);
    // No other machine has the project.
    const none = chooser();
    expect(await createAutoRunOnHook(environments, none).claimNewThread!(claim({ projectPath: "/work/web" }), fakeActions({ notify }))).toBe(false);
    expect(none.invoke).not.toHaveBeenCalled();
    expect(await createAutoRunOnHook(environments, chooser()).claimNewThread!(claim({ attachments: 1 }), fakeActions({ notify }))).toBe(false);
    expect(notify).toHaveBeenLastCalledWith("Attachments stay on this computer, so Automatic starts this thread here.");
    environments.open.mockRejectedValueOnce(new Error("studio is not connected"));
    expect(await createAutoRunOnHook(environments, chooser()).claimNewThread!(claim(), fakeActions({ notify }))).toBe(false);
    expect(notify).toHaveBeenLastCalledWith("Could not move to the chosen machine (studio is not connected); this thread starts here.");
    expect(environments.open).toHaveBeenCalledTimes(1);
  });

  it("sends an arriving prompt as the new thread's first, on the model it had", async () => {
    let pending = false;
    const setModel = vi.fn(async () => true);
    const submitPrompt = vi.fn(async () => true);
    const setComposerDraft = vi.fn();
    const actions = fakeActions({ newSession: vi.fn(() => { pending = true; }), activeThread: () => pending ? { draftPending: true, workspaceId: "ws-api" } : undefined, setModel, submitPrompt, setComposerDraft });
    expect(await followArrival({ newThread: { draft: "Fix the parser", workspaceId: "ws-api", send: true, model: luna } }, { actions, wait: async () => undefined })).toBe(true);
    expect(setModel).toHaveBeenCalledWith("openai-codex", "gpt-5.6-luna");
    expect(submitPrompt).toHaveBeenCalledWith("Fix the parser");
    expect(setComposerDraft).not.toHaveBeenCalled();
    expect(readPendingArrival(JSON.stringify({ machine: "studio", target: { newThread: { draft: "x", send: true, model: luna } } }))?.target).toEqual({ newThread: { draft: "x", send: true, model: luna } });
  });

  it("keeps an arriving prompt in the composer when it could not be sent", async () => {
    let text = "";
    const notify = vi.fn();
    const actions = fakeActions({
      activeThread: () => ({ draftPending: true }),
      submitPrompt: vi.fn(async () => false),
      setComposerDraft: vi.fn((value: string) => { text = value; }),
      composerDraft: () => text,
      notify,
    });
    expect(await followArrival({ newThread: { draft: "Fix the parser", send: true } }, { actions, wait: async () => undefined })).toBe(true);
    expect(text).toBe("Fix the parser");
    expect(notify).toHaveBeenCalledWith("The prompt did not go out here; it waits in the composer.");
  });
});

describe("Settings → Machines → Automatic", () => {
  it("weighs this computer and each machine its agents reach, 5 and 50 unless set", async () => {
    const { environments } = fakeEnvironments({ shown: "laptop", environments: [laptop, studio, attic], secureStorage: true });
    const host = {
      invoke: vi.fn(async (command: string) => (command === "agents" ? { available: true, machines: [{ id: "studio", name: "studio", status: "connected" }] } : new Promise(() => undefined))),
      onEvent: vi.fn(() => () => undefined),
    };
    let values: Record<string, string> = { "tau.environments.weights": JSON.stringify({ studio: 70 }) };
    const updateConfig = vi.fn(async (patch: { values?: Record<string, string> }) => { values = { ...values, ...patch.values }; return { values }; });
    const client = { hasCapability: () => true, isReadOnly: () => false, onConnectionState: () => () => undefined, getConfigLayers: async () => ({ host: { values } }), updateConfig, clearConfig: vi.fn() };
    const Page = createMachinesPage({ ...environments, setAgents: vi.fn() }, host);
    render(withSettings(<Page />, client));
    await vi.waitFor(() => expect((screen.getByRole("spinbutton", { name: "Weight of studio" }) as HTMLInputElement).value).toBe("70"));
    const here = screen.getByRole("spinbutton", { name: "Weight of laptop" }) as HTMLInputElement;
    expect(here.value).toBe("5");
    // attic's agents are not let in, so it cannot be measured.
    expect(screen.queryByRole("spinbutton", { name: "Weight of attic" })).toBeNull();
    fireEvent.change(here, { target: { value: "0" } });
    fireEvent.blur(here);
    await vi.waitFor(() => expect(updateConfig).toHaveBeenCalled());
    expect(JSON.stringify(updateConfig.mock.calls[0])).toContain(JSON.stringify(JSON.stringify({ studio: 70, laptop: 0 })));
    await vi.waitFor(() => expect(screen.getByText("Never chosen automatically.")).toBeTruthy());
    // Out of range stays in the field with the reason, and is not written.
    const other = screen.getByRole("spinbutton", { name: "Weight of studio" }) as HTMLInputElement;
    fireEvent.change(other, { target: { value: "140" } });
    fireEvent.blur(other);
    expect(other.value).toBe("140");
    expect(screen.getByRole("alert").textContent).toBe("Enter a number from 0 to 100.");
    expect(updateConfig).toHaveBeenCalledTimes(1);
  });
});
