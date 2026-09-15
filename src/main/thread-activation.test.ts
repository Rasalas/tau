import { describe, expect, it, vi } from "vitest";
import { HostLifecycleCoordinator } from "./host-lifecycle-coordinator.js";
import { ThreadActivation, type ThreadActivationPort, type VisibleThreadState } from "./thread-activation.js";
import type { ThreadRuntime } from "./thread-runtime.js";

function runtime(id: string): ThreadRuntime {
  return {
    threadId: id,
    sessionId: id,
    cwd: "/repo",
    backend: {
      kind: "pi",
      state: () => ({ streaming: false, idle: true, hasMessages: true, extensionCount: 0 }),
      catalogView: () => ({ usage: undefined }),
      waitForIdle: async () => undefined,
    },
    adapterStreaming: false,
    adapterPending: 0,
    entries: [],
    appendJournalEntry: () => undefined,
  } as unknown as ThreadRuntime;
}

function portFor(target: ThreadRuntime, hooks: {
  before?: () => Promise<unknown>;
  remember?: () => Promise<void>;
  refresh?: () => Promise<void>;
  rollback?: () => Promise<void>;
} = {}): ThreadActivationPort & { state: VisibleThreadState; published: number; rolledBack: number; committed: number } {
  const state: VisibleThreadState = { active: undefined, cwd: "/old", extensionCount: 2 };
  let visibleGeneration = 0;
  const result = {
    state,
    published: 0,
    rolledBack: 0,
    committed: 0,
    assertHostOwned: vi.fn(),
    isCurrentRuntime: vi.fn(() => true),
    beforeActivate: vi.fn(async () => hooks.before ? await hooks.before() as never : {
      commit: async () => { result.committed += 1; },
      rollback: async () => { result.rolledBack += 1; await hooks.rollback?.(); },
    }),
    adopt: vi.fn(async () => undefined),
    captureVisibleState: vi.fn(() => ({ ...state })),
    setVisible: vi.fn((thread: ThreadRuntime, generation: number) => { visibleGeneration = generation; state.active = thread; state.cwd = thread.cwd; state.extensionCount = 0; }),
    restoreVisibleState: vi.fn((previous: VisibleThreadState, _expected: ThreadRuntime, generation: number) => {
      if (visibleGeneration !== generation) return;
      state.active = previous.active;
      state.cwd = previous.cwd;
      state.extensionCount = previous.extensionCount;
      visibleGeneration = generation + 1;
    }),
    rememberProject: vi.fn(async () => { await hooks.remember?.(); }),
    refreshShell: vi.fn(async () => { await hooks.refresh?.(); }),
    publishVisible: vi.fn(() => { result.published += 1; }),
  };
  return result;
}

describe("ThreadActivation", () => {
  it("does not leave a stale backend in visible pointers", async () => {
    const coordinator = new HostLifecycleCoordinator();
    const target = runtime("new");
    let invalidate!: () => void;
    const gate = new Promise<void>((resolve) => { invalidate = resolve; });
    const port = portFor(target, { remember: async () => { await gate; } });
    const activation = new ThreadActivation(port);
    const lease = coordinator.activation(coordinator.beginActivation());
    const promotion = activation.promote(target, true, lease);
    await vi.waitFor(() => { expect(port.setVisible).toHaveBeenCalledOnce(); });
    coordinator.beginActivation();
    invalidate();

    await expect(promotion).resolves.toBe(false);
    expect(port.restoreVisibleState).toHaveBeenCalledWith({ active: undefined, cwd: "/old", extensionCount: 2 }, target, 1);
    expect(port.state.active).toBeUndefined();
    expect(port.published).toBe(0);
  });

  it("rolls back extension state and pointers when publication fails", async () => {
    const coordinator = new HostLifecycleCoordinator();
    const target = runtime("new");
    const port = portFor(target);
    port.publishVisible = vi.fn(() => { throw new Error("publish failed"); });
    const activation = new ThreadActivation(port);

    await expect(activation.promote(target, true, coordinator.activation(coordinator.beginActivation())))
      .rejects.toThrow("publish failed");
    expect(port.rolledBack).toBe(1);
    expect(port.restoreVisibleState).toHaveBeenCalledWith({ active: undefined, cwd: "/old", extensionCount: 2 }, target, 1);
    expect(port.state.active).toBeUndefined();
  });

  it("does not let an older rollback clear a newer activation of the same runtime", async () => {
    const coordinator = new HostLifecycleCoordinator();
    const target = runtime("same-thread");
    let releaseFirst!: () => void;
    let firstRemember = true;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const port = portFor(target, {
      remember: async () => {
        if (firstRemember) {
          firstRemember = false;
          await gate;
        }
      },
    });
    const activation = new ThreadActivation(port);

    const first = activation.promote(target, true, coordinator.activation(coordinator.beginActivation()));
    await vi.waitFor(() => { expect(port.setVisible).toHaveBeenCalledWith(target, 1); });
    const second = activation.promote(target, true, coordinator.activation(coordinator.beginActivation()));
    await expect(second).resolves.toBe(true);
    releaseFirst();

    await expect(first).resolves.toBe(false);
    expect(port.state.active).toBe(target);
    expect(port.restoreVisibleState).toHaveBeenCalledWith({ active: undefined, cwd: "/old", extensionCount: 2 }, target, 1);
  });

  it("restores pointers even when extension rollback fails", async () => {
    const coordinator = new HostLifecycleCoordinator();
    const target = runtime("rollback-failure");
    const rollbackError = new Error("extension rollback failed");
    const port = portFor(target, { rollback: async () => { throw rollbackError; } });
    port.publishVisible = vi.fn(() => { throw new Error("publish failed"); });
    const activation = new ThreadActivation(port);

    await expect(activation.promote(target, true, coordinator.activation(coordinator.beginActivation())))
      .rejects.toThrow("Thread activation failed and workspace recovery needs attention.");
    expect(port.restoreVisibleState).toHaveBeenCalledWith({ active: undefined, cwd: "/old", extensionCount: 2 }, target, 1);
    expect(port.state.active).toBeUndefined();
  });
});
