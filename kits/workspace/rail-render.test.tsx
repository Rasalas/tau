// @vitest-environment jsdom
import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopExtension, UiSession } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { setClientStorage, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { workspaceExtension } from "./desktop.js";
import { WORKSPACE_STORE_SERVICE, type ThreadRailOrganizer, type WorkspaceStoreApi } from "./protocol.js";
import type { WorkspaceStore } from "./store.js";

// A row mark renders with its row, so counting the mark counts row renders.
const rowRenders = { count: 0 };
function CountingMark() {
  rowRenders.count += 1;
  return null;
}

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

const THREADS = 1_000;

function shells(count: number): UiSession[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `thread-${index}`,
    path: `/sessions/thread-${index}.jsonl`,
    title: `Thread ${index}`,
    modifiedAt: 1_000_000 - index,
    projectPath: `/projects/p${index % 12}`,
    projectName: `p${index % 12}`,
    projectLabel: index % 3 === 0 ? `feature/branch-${index}` : "main",
    messageCount: 3,
  }));
}

/** Four labelled runs of 25 rows each, so jsdom draws 100 rows without the virtual list. */
function organizer(): ThreadRailOrganizer & { bump(): void } {
  const listeners = new Set<() => void>();
  let version = 1;
  return {
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getVersion: () => version,
    bump: () => { version += 1; listeners.forEach((listener) => listener()); },
    sections: (threads) => [
      ...["a", "b", "c", "d"].map((id, index) => ({ id, label: id.toUpperCase(), threads: threads.slice(index * 25, index * 25 + 25) })),
      { id: "active", threads: threads.slice(100) },
    ],
    menu: () => [],
    runMenu: () => undefined,
    toggleSettled: () => undefined,
    dropLabel: () => undefined,
    drop: () => undefined,
  };
}

async function renderRail() {
  const rail = organizer();
  let workspace: WorkspaceStore | undefined;
  const organizing: DesktopExtension = {
    id: "test.organizer",
    name: "Organizer",
    activate: (context) => context.useService<WorkspaceStoreApi>(WORKSPACE_STORE_SERVICE, (store) => {
      workspace = store as WorkspaceStore;
      const stops = [store.registerThreadRailOrganizer(rail), store.registerThreadRowAccessory(CountingMark)];
      return () => stops.forEach((stop) => stop());
    }),
  };
  const sessions = shells(THREADS);
  const client = createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: Array.from({ length: 12 }, (_, index) => ({ path: `/projects/p${index}`, name: `p${index}`, lastOpenedAt: index })), sessions },
      detail: { sessionId: "thread-0", messages: [], isStreaming: false, activeTools: [] },
      catalog: { sessionId: "thread-0", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
      project: { cwd: "/projects/p0" },
    }),
    invokeHostExtension: workspaceHostStub(),
  });
  const started = performance.now();
  const { services } = renderApp(client, { extensions: [workspaceExtension, organizing] });
  await screen.findByText("Thread 99");
  const mountMs = performance.now() - started;
  return { client, rail, mountMs, preferences: services.preferences, workspace: workspace! };
}

const timed = (run: () => void) => {
  rowRenders.count = 0;
  const started = performance.now();
  act(run);
  return { rows: rowRenders.count, ms: performance.now() - started };
};

const median = (values: number[]) => values.slice().sort((left, right) => left - right)[Math.floor(values.length / 2)]!;

describe("rail render cost with a thousand threads", () => {
  it("redraws only the rows whose state changed", async () => {
    const { client, rail, mountMs } = await renderRail();
    const runs = { running: [] as number[], stopped: [] as number[], organizer: [] as number[] };
    const rows = { running: 0, stopped: 0, organizer: 0 };
    for (let round = 0; round < 15; round += 1) {
      const running = timed(() => client.emit({ type: "agent-status", sessionId: "thread-30", running: true }));
      const stopped = timed(() => client.emit({ type: "agent-status", sessionId: "thread-30", running: false }));
      const organized = timed(() => rail.bump());
      runs.running.push(running.ms); runs.stopped.push(stopped.ms); runs.organizer.push(organized.ms);
      rows.running = Math.max(rows.running, running.rows); rows.stopped = Math.max(rows.stopped, stopped.rows); rows.organizer = Math.max(rows.organizer, organized.rows);
    }
    // Printed for docs/PERFORMANCE.md (medians of 15); the row counts below are what the test holds.
    console.info(`[rail-render] threads=${THREADS} mount=${mountMs.toFixed(0)}ms running=${rows.running} rows/${median(runs.running).toFixed(2)}ms stopped=${rows.stopped} rows/${median(runs.stopped).toFixed(2)}ms organizer=${rows.organizer} rows/${median(runs.organizer).toFixed(2)}ms`);
    expect(rows.running).toBeLessThanOrEqual(2);
    expect(rows.stopped).toBeLessThanOrEqual(2);
    expect(rows.organizer).toBe(0);
  });

  it("leaves the rows alone when a setting, the selection or another thread's stat changes", async () => {
    const { preferences, workspace } = await renderRail();
    const setting = timed(() => preferences.setOption("tau.appearance", "some-toggle", true));
    const row = screen.getByText("Thread 40").closest("[data-rail-thread]") as HTMLElement;
    const selecting = timed(() => { row.querySelector<HTMLButtonElement>(".thread-main")!.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true })); });
    const stat = timed(() => workspace.recordTurnStat("thread-50", { added: 3, removed: 1, files: 1, at: 1 }));
    console.info(`[rail-render] setting=${setting.rows} rows/${setting.ms.toFixed(2)}ms select=${selecting.rows} rows/${selecting.ms.toFixed(2)}ms stat=${stat.rows} rows/${stat.ms.toFixed(2)}ms`);
    expect(row.classList.contains("selected")).toBe(true);
    expect(setting.rows).toBe(0);
    expect(selecting.rows).toBe(0);
    expect(stat.rows).toBe(1);
  });
});
