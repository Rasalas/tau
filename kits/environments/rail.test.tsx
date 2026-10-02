// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionClient, PlatformEnvironments, UiEnvironment, UiSession } from "tau";
import { ThreadStore } from "../../src/renderer/test-support/kit-harness.js";
import { createMachineCardRow, createMachineThreads } from "./rail.js";
import { AGENTS_EVENT, type AgentMachines } from "./protocol.js";

afterEach(cleanup);

function fixture() {
  const machine = (id: string): UiEnvironment => ({
    id, name: id, status: "connected", local: false, projects: [], threadCount: 1,
    threads: [{ id: `${id}-thread`, path: `/${id}/thread`, title: id, projectName: "api", modifiedAt: 1 }],
  });
  const snapshot = { shown: "mini", secureStorage: true, environments: [{ ...machine("mini"), local: true }, machine("rex"), machine("external")] };
  const environments = {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
  } as unknown as PlatformEnvironments;
  let receive: (payload: unknown) => void = () => undefined;
  const off = vi.fn();
  const host = {
    invoke: vi.fn(async (): Promise<unknown> => ({ available: true, machines: [{ id: "rex", name: "rex", status: "connected" }] })),
    onEvent: vi.fn((name, listener) => { expect(name).toBe(AGENTS_EVENT); receive = listener; return off; }),
  } satisfies HostExtensionClient;
  const emit = (machines: AgentMachines["machines"]) => receive({ available: true, machines });
  return { environments, host, emit, off };
}

const proxy: UiSession = {
  id: "rex~thread", path: "rex~thread", title: "Proxy", modifiedAt: 1, messageCount: 1,
  projectPath: "/api", projectName: "api", backendKind: "machine",
  machine: { id: "rex", name: "Rex", backendKind: "codex" },
};

describe("machine rows alongside the own index", () => {
  it("reads agents once and follows connection changes while subscribed", async () => {
    const { environments, host, emit, off } = fixture();
    const source = createMachineThreads(environments, host);
    const stop = source.subscribe(vi.fn());
    try {
      await waitFor(() => expect(source.threads().map((row) => row.machine.name)).toEqual(["external"]));
      expect(host.invoke).toHaveBeenCalledExactlyOnceWith("agents");
      emit([{ id: "rex", name: "rex", status: "offline" }]);
      expect(source.threads().map((row) => row.machine.name)).toEqual(["external", "rex"]);
      emit([{ id: "rex", name: "rex", status: "refused" }]);
      expect(source.threads()).toHaveLength(2);
    } finally { stop(); }
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("keeps offline proxies ordinary and restores external rows when the own index drops them", async () => {
    const { environments, host, emit } = fixture();
    const source = createMachineThreads(environments, host);
    const own = new ThreadStore();
    own.applyThreadIndex({ projects: [], sessions: [proxy] });
    source.bindOwnThreads(own);
    const changed = vi.fn();
    const stop = source.subscribe(changed);
    try {
      await waitFor(() => expect(host.invoke).toHaveBeenCalled());
      emit([{ id: "rex", name: "rex", status: "offline" }]);
      expect(source.threads().map((row) => row.machine.name)).toEqual(["external"]);
      changed.mockClear();
      own.setThreadRunning(proxy.id, true);
      expect(changed).not.toHaveBeenCalled();
      own.applyThreadIndex({ projects: [], sessions: [] });
      expect(source.threads().map((row) => row.machine.name)).toEqual(["external", "rex"]);
      expect(changed).toHaveBeenCalled();
    } finally { stop(); }
  });

  it("lets a newer agents event win over the initial read, and ignores reads after disposal", async () => {
    const { environments, host, emit } = fixture();
    let answer: (value: unknown) => void = () => undefined;
    host.invoke = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    const source = createMachineThreads(environments, host);
    const changed = vi.fn();
    const stop = source.subscribe(changed);
    emit([{ id: "rex", name: "rex", status: "offline" }]);
    answer({ available: true, machines: [{ id: "rex", status: "connected" }] });
    await Promise.resolve();
    expect(source.threads()).toHaveLength(2);
    stop();
    const stopAgain = source.subscribe(changed);
    stopAgain();
    changed.mockClear();
    answer({ available: true, machines: [{ id: "rex", status: "connected" }] });
    await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
  });

  it("names the proxy's home machine on its ordinary hover card", async () => {
    const { environments } = fixture();
    const MachineRow = createMachineCardRow(environments);
    const rendered = render(<MachineRow session={proxy} external={false} Row={({ icon, children }) => <div>{icon}{children}</div>} />);
    expect(await screen.findByText("Rex")).toBeTruthy();
    rendered.rerender(<MachineRow session={proxy} external Row={({ children }) => <div>{children}</div>} />);
    await waitFor(() => expect(screen.queryByText("Rex")).toBeNull());
  });
});
