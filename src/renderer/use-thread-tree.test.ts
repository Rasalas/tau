// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { HostClient } from "../workbench/host-client";
import { useThreadTree } from "./use-thread-tree";

describe("Edit from here", () => {
  it("rewinds to before the prompt and puts it into the composer below the draft", async () => {
    const navigateThreadTree = vi.fn(async () => ({ version: 1 as const, updates: [], cancelled: false, draftText: "fix the bug" }));
    const seedComposer = vi.fn();
    const applyActionResult = vi.fn(() => true);
    const { result } = renderHook(() => useThreadTree({
      client: { navigateThreadTree } as unknown as HostClient,
      sessionId: () => "s1",
      requireHost: () => true,
      applyActionResult,
      seedComposer,
      composerDraft: () => "half a thought ",
      composerRef: createRef<HTMLTextAreaElement>(),
    }));
    await act(() => result.current.editFromMessage({ id: "u1", sourceEntryId: "e1", role: "user", text: "fix the bug", timestamp: 0 }));
    expect(navigateThreadTree).toHaveBeenCalledWith("e1", { summarize: false }, "s1");
    expect(applyActionResult).toHaveBeenCalled();
    expect(seedComposer).toHaveBeenCalledWith("half a thought\n\nfix the bug");
  });

  it("does nothing for a message the runtime cannot rewind to", async () => {
    const navigateThreadTree = vi.fn();
    const { result } = renderHook(() => useThreadTree({
      client: { navigateThreadTree } as unknown as HostClient,
      sessionId: () => "s1",
      requireHost: () => true,
      applyActionResult: () => true,
      seedComposer: vi.fn(),
      composerRef: createRef<HTMLTextAreaElement>(),
    }));
    await act(() => result.current.editFromMessage({ id: "u1", role: "user", text: "hi", timestamp: 0 }));
    expect(navigateThreadTree).not.toHaveBeenCalled();
  });
});

describe("the thread tree", () => {
  it("fills the modal with the answer to its latest opening, not a late one for another thread", async () => {
    const replies: Record<string, (tree: unknown) => void> = {};
    const threadTree = vi.fn((sessionId: string) => new Promise((resolve) => { replies[sessionId] = resolve; }));
    let shown = "A";
    const { result } = renderHook(() => useThreadTree({
      client: { threadTree } as unknown as HostClient,
      sessionId: () => shown,
      requireHost: () => true,
      applyActionResult: () => true,
      seedComposer: vi.fn(),
      composerRef: createRef<HTMLTextAreaElement>(),
    }));
    act(() => result.current.openThreadTree());
    act(() => result.current.closeThreadTree());
    shown = "B";
    act(() => result.current.openThreadTree());
    const treeOfB = { entries: [{ id: "b" }] };
    await act(async () => { replies.B!(treeOfB); replies.A!({ entries: [{ id: "a" }] }); });
    expect(result.current.threadTreeModal?.tree).toBe(treeOfB);
  });
});
