import { describe, expect, it } from "vitest";
import type { WorkspaceKitState } from "./protocol.js";
import { threadBranchService } from "./branch-service.js";

function store(state: Partial<WorkspaceKitState>) {
  let current = state as WorkspaceKitState;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(next: Partial<WorkspaceKitState>) { current = { ...current, ...next } as WorkspaceKitState; for (const listener of listeners) listener(); },
  };
}

const info = (branch?: string) => ({ root: "/repo", isRepo: true, isDirty: false, worktrees: [], refs: [], worktreeParent: "/w", ...(branch ? { branch, upstream: `origin/${branch}` } : {}) });

describe("the thread branch service", () => {
  it("hands out the branch on screen, the same object until it changes", () => {
    const workspace = store({ cwd: "/repo", workspace: info("fix/K112-kit") });
    const service = threadBranchService(workspace);
    const first = service.current();
    expect(first).toEqual({ cwd: "/repo", isRepo: true, branch: "fix/K112-kit", upstream: "origin/fix/K112-kit" });
    let told = 0;
    service.subscribe(() => { told += 1; });
    workspace.set({ changes: { files: [] } as never });
    expect(service.current()).toBe(first);
    workspace.set({ workspace: info() });
    expect(service.current()).toEqual({ cwd: "/repo", isRepo: true });
    expect(told).toBe(2);
    workspace.set({ cwd: undefined });
    expect(service.current()).toBeUndefined();
  });
});
