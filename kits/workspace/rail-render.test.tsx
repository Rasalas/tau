// @vitest-environment jsdom
import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopExtension, UiSession } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { setClientStorage, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { workspaceExtension } from "./desktop.js";
import { WORKSPACE_STORE_SERVICE, type ThreadRailOrganizer, type WorkspaceStoreApi } from "./protocol.js";

// Every draw of a rail row goes through core's ThreadRow; counting it counts row renders.
const rowRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../src/renderer/components/ThreadRow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/components/ThreadRow")>();
  const Real = actual.ThreadRow;
  const Counted = (props: Parameters<typeof Real>[0]) => { rowRenders.count += 1; return <Real {...props} />; };
  return { ...actual, ThreadRow: Counted };
});

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
  const organizing: DesktopExtension = {
    id: "test.organizer",
    name: "Organizer",
    activate: (context) => context.useService<WorkspaceStoreApi>(WORKSPACE_STORE_SERVICE, (store) => store.registerThreadRailOrganizer(rail)),
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
  renderApp(client, { extensions: [workspaceExtension, organizing] });
  await screen.findByText("Thread 99");
  const mountMs = performance.now() - started;
  return { client, rail, mountMs };
}

const timed = (run: () => void) => {
  rowRenders.count = 0;
  const started = performance.now();
  act(run);
  return { rows: rowRenders.count, ms: performance.now() - started };
};

describe("rail render cost with a thousand threads", () => {
  it("redraws only the rows whose state changed", async () => {
    const { client, rail, mountMs } = await renderRail();
    const running = timed(() => client.emit({ type: "agent-status", sessionId: "thread-30", running: true }));
    const stopped = timed(() => client.emit({ type: "agent-status", sessionId: "thread-30", running: false }));
    const organized = timed(() => rail.bump());
    // Printed for docs/PERFORMANCE.md; the counts below are what the test holds.
    console.info(`[rail-render] threads=${THREADS} mount=${mountMs.toFixed(0)}ms running=${running.rows} rows/${running.ms.toFixed(1)}ms stopped=${stopped.rows} rows/${stopped.ms.toFixed(1)}ms organizer=${organized.rows} rows/${organized.ms.toFixed(1)}ms`);
    expect(running.rows).toBeLessThanOrEqual(2);
    expect(stopped.rows).toBeLessThanOrEqual(2);
    expect(organized.rows).toBe(0);
  });
});
