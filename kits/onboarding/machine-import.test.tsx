// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlatformEnvironments, WorkbenchActions } from "tau";
import { createKitHarness, WorkbenchShellContext } from "../../src/renderer/test-support/kit-harness.js";
import onboarding from "./desktop.js";
import { MachineImport } from "./machine-import.js";
import { MACHINE_IMPORT_SERVICE, type Discovery, type MachineImportService } from "./protocol.js";

afterEach(cleanup);

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const discovery: Discovery = {
  projects: [{ path: "/work/tau", name: "tau", sources: ["codex"], threadCount: 3, lastActiveAt: NOW, git: true }],
  sessions: [
    { source: "codex", path: "/codex/one", sessionId: "one", cwd: "/work/tau", title: "Fix the build", updatedAt: NOW - DAY, imported: false },
    { source: "codex", path: "/codex/two", sessionId: "two", cwd: "/work/tau", title: "Write docs", updatedAt: NOW - 2 * DAY, imported: false },
    { source: "claude-code", path: "/claude/old", sessionId: "old", cwd: "/work/old", title: "Old work", updatedAt: NOW - 90 * DAY, imported: false },
    { source: "codex", path: "/codex/imported", sessionId: "imported", cwd: "/work/tau", title: "Already imported", updatedAt: NOW, imported: true },
  ],
  truncated: false,
  unavailable: [],
};

function fixture(invoke = async (command: string, input?: unknown): Promise<unknown> => command === "discover" ? discovery : { imported: (input as { paths: string[] }).paths.length, skipped: 0, failed: 0 }) {
  const events = new Set<(event: string, payload: unknown) => void>();
  const invokeExtension = vi.fn(async (_machine: string, _kit: string, command: string, input?: unknown) => invoke(command, input));
  const onExtensionEvent = vi.fn((_machine: string, _kit: string, listener: (event: string, payload: unknown) => void) => {
    events.add(listener);
    return () => { events.delete(listener); };
  });
  const environments: PlatformEnvironments = {
    getSnapshot: () => undefined,
    subscribe: () => () => undefined,
    pair: vi.fn(), cancelPairing: vi.fn(), rename: vi.fn(), remove: vi.fn(), retry: vi.fn(), open: vi.fn(),
    takeArrival: vi.fn(), showLocal: vi.fn(), discover: vi.fn(), setPreferences: vi.fn(),
    invokeExtension, onExtensionEvent,
  };
  return { environments, invokeExtension, onExtensionEvent, listenerCount: () => events.size, emit: (event: string, payload: unknown) => act(() => { for (const listener of events) listener(event, payload); }) };
}

async function open() {
  const details = screen.getByText("Earlier conversations on rex").closest("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
  await screen.findByRole("checkbox", { name: /Fix the build/u });
}

describe("A machine's earlier conversations", () => {
  it("lists only when expanded, selects nothing, and imports the exact chosen paths there", async () => {
    const { environments, invokeExtension } = fixture();
    render(<MachineImport machine="rex-id" name="rex" environments={environments} />);
    expect(invokeExtension).not.toHaveBeenCalled();
    await open();
    expect(invokeExtension).toHaveBeenCalledWith("rex-id", "tau.onboarding", "discover", undefined, { timeoutMs: 600000 });
    for (const input of screen.getAllByRole("checkbox")) expect((input as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByText("Already imported")).toBeNull();
    expect((screen.getByRole("button", { name: "Import 0" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Fix the build/u }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Write docs/u }));
    fireEvent.click(screen.getByRole("button", { name: "Import 2" }));
    await screen.findByText("Imported 2 threads.");
    expect(invokeExtension).toHaveBeenCalledWith("rex-id", "tau.onboarding", "import-sessions", { source: "codex", paths: ["/codex/one", "/codex/two"] }, { timeoutMs: 600000 });
  });

  it("selects recent sessions of the discovered projects only on request", async () => {
    const { environments } = fixture();
    render(<MachineImport machine="rex-id" name="rex" environments={environments} />);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Select recent (30 days)" }));
    expect((screen.getByRole("checkbox", { name: /Fix the build/u }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Write docs/u }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Old work/u }) as HTMLInputElement).checked).toBe(false);
  });

  it("shows remote progress and removes its event listener on unmount", async () => {
    let finish!: (value: unknown) => void;
    const { environments, emit, invokeExtension, listenerCount } = fixture(async (command) => command === "discover" ? discovery : new Promise((resolve) => { finish = resolve; }));
    const { registry } = createKitHarness();
    const applyHostResult = vi.fn();
    const view = render(<WorkbenchShellContext.Provider value={{ registry, actions: { applyHostResult } as unknown as WorkbenchActions }}>
      <MachineImport machine="rex-id" name="rex" environments={environments} />
    </WorkbenchShellContext.Provider>);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Select recent (30 days)" }));
    fireEvent.click(screen.getByRole("button", { name: "Import 2" }));
    await waitFor(() => expect(invokeExtension).toHaveBeenCalledWith("rex-id", "tau.onboarding", "import-sessions", expect.anything(), expect.anything()));
    emit("import-progress", { source: "codex", done: 1, total: 2 });
    await screen.findByRole("button", { name: "Importing… 1 of 2" });
    await act(async () => { finish({ imported: 2, skipped: 0, failed: 0, update: { wrongMachine: true } }); });
    await screen.findByText("Imported 2 threads.");
    expect(applyHostResult).not.toHaveBeenCalled();
    expect(listenerCount()).toBe(1);
    view.unmount();
    expect(listenerCount()).toBe(0);
  });

  it("imports per source and sums the summary when one source fails", async () => {
    const { environments, invokeExtension } = fixture(async (command, input) => {
      if (command === "discover") return discovery;
      if ((input as { source: string }).source === "claude-code") throw new Error("Offline");
      return { imported: 2, skipped: 0, failed: 0 };
    });
    render(<MachineImport machine="rex-id" name="rex" environments={environments} />);
    await open();
    for (const title of ["Fix the build", "Write docs", "Old work"]) fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(title, "u") }));
    fireEvent.click(screen.getByRole("button", { name: "Import 3" }));
    await screen.findByText("Imported 2 threads. 1 thread could not be imported.");
    expect(invokeExtension.mock.calls.filter((call) => call[2] === "import-sessions").map((call) => call[3])).toEqual([
      { source: "claude-code", paths: ["/claude/old"] }, { source: "codex", paths: ["/codex/one", "/codex/two"] },
    ]);
  });

  it("reports a listing failure and lets the user retry", async () => {
    let failed = false;
    const { environments } = fixture(async () => { if (!failed) { failed = true; throw new Error("rex is offline"); } return discovery; });
    render(<MachineImport machine="rex-id" name="rex" environments={environments} />);
    const details = screen.getByText("Earlier conversations on rex").closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await screen.findByText(/Could not list conversations. rex is offline/u);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("checkbox", { name: /Fix the build/u });
  });

  it("provides its component only where the window can invoke another machine's kits", () => {
    const { environments } = fixture();
    const { registry } = createKitHarness(undefined, undefined, { environments });
    let service: MachineImportService | undefined;
    registry.activate({ id: "test.import-consumer", name: "Import consumer", activate: (context) => {
      context.useService<MachineImportService>(MACHINE_IMPORT_SERVICE, (value) => { service = value; return () => { service = undefined; }; });
    } });
    registry.activate(onboarding);
    expect(service).toBeDefined();
    const Component = service!.Component;
    render(<Component machine="rex-id" name="rex" />);
    expect(screen.getByText("Earlier conversations on rex")).toBeDefined();
    registry.deactivate(onboarding.id);
    expect(service).toBeUndefined();
    const noMachines = createKitHarness();
    noMachines.registry.activate(onboarding);
    expect(noMachines.registry.getServiceIds()).not.toContain(MACHINE_IMPORT_SERVICE);
  });
});
