// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HOST_PROTOCOL_VERSION, type HostActionResult } from "../shared/host-protocol";
import type { DraftKey } from "../workbench/composer-scope-store";
import type { HostClient } from "../workbench/host-client";
import { useThreadNavigation, type ThreadNavigationPorts } from "./use-thread-navigation";

describe("opening a project", () => {
  it("does not pull the user back when the host answers after they went to another thread", async () => {
    let opened!: (result: HostActionResult) => void;
    const openProject = vi.fn(() => new Promise<HostActionResult>((resolve) => { opened = resolve; }));
    let scope = "session:A";
    const workbench = { applyActionResult: vi.fn(), applySnapshot: vi.fn(), applyHostResult: vi.fn(), applyHostUpdate: vi.fn() };
    const { result } = renderHook(() => useThreadNavigation({
      client: { openProject } as unknown as HostClient,
      view: { getSnapshot: () => ({ sessionId: "A", cwd: "/a" }), setNotice: vi.fn() },
      threads: { getProjects: () => [] },
      newThread: { current: () => undefined },
      activeDraftKey: () => scope as DraftKey,
      requireHost: () => true,
      detachPendingDelivery: () => false,
      workbench,
    } as unknown as ThreadNavigationPorts));
    const opening = result.current.openWorkspace("/p");
    scope = "session:B";
    const index = { version: HOST_PROTOCOL_VERSION, type: "thread-index", index: { projects: [], sessions: [] } };
    const detail = { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: { sessionId: "P" } };
    opened({ version: HOST_PROTOCOL_VERSION, updates: [index, detail] } as unknown as HostActionResult);
    await expect(opening).resolves.toBe(false);
    expect(workbench.applyHostResult).not.toHaveBeenCalled();
    expect(workbench.applyHostUpdate).toHaveBeenCalledExactlyOnceWith(index);
  });
});
