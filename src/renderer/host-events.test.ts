// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ExtensionRegistry } from "./extension-system";
import { applyHostEvent, type HostEventTargets } from "./host-events";
import { ThreadStore } from "./thread-store";
import { ThreadViewStore } from "./thread-view-store";

function fixture() {
  const threadStore = new ThreadStore();
  threadStore.setActiveThread("active");
  const view = new ThreadViewStore();
  view.beginThread("active");
  const registry = { dispatchWorkbenchEvent: vi.fn(), dispatchExtensionEvent: vi.fn(), interceptPrompt: vi.fn(() => undefined) };
  const targets: HostEventTargets = {
    registry: registry as unknown as ExtensionRegistry,
    threadStore,
    view,
    recoveries: new Map(),
    currentDraftKey: () => undefined,
    transcriptTurnStart: () => undefined,
    setTranscriptTurnStart: vi.fn(),
    settleNewThreadDelivery: vi.fn(() => true),
    promoteRecoveryToSession: vi.fn(() => true),
    applyHostUpdate: vi.fn(),
    applyThreadIndex: vi.fn(),
  };
  return { targets, threadStore, view, registry };
}

describe("applyHostEvent", () => {
  it("routes host updates through the store boundary", () => {
    const { targets } = fixture();
    const update = { version: 1, type: "project", project: { cwd: "/repo" } } as const;

    applyHostEvent({ type: "host-update", update }, targets);

    expect(targets.applyHostUpdate).toHaveBeenCalledWith(update);
  });

  it("makes the per-thread run state the only writer of streaming", () => {
    const { targets, threadStore } = fixture();

    applyHostEvent({ type: "agent-status", sessionId: "active", running: true }, targets);

    expect(threadStore.getActivity().isStreaming).toBe(true);
    expect(threadStore.getActivity().runningThreadIds).toEqual(["active"]);

    applyHostEvent({ type: "agent-status", sessionId: "active", running: false }, targets);

    expect(threadStore.getActivity().isStreaming).toBe(false);
    expect(threadStore.getActivity().runningThreadIds).toEqual([]);
  });

  it("flushes pending tool output when the active run stops", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      const { targets, view } = fixture();
      const tool = { id: "tool-1", name: "read", args: {}, status: "running" as const, startedAt: 1 };
      applyHostEvent({ type: "tool-start", sessionId: "active", tool }, targets);
      applyHostEvent({ type: "tool-update", sessionId: "active", id: "tool-1", output: "partial" }, targets);
      expect(view.getToolView().tools[0].output).toBeUndefined();

      applyHostEvent({ type: "agent-status", sessionId: "active", running: false }, targets);

      expect(view.getToolView().tools[0].output).toBe("partial");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("tracks a background thread's run without projecting its transcript", () => {
    const { targets, threadStore, view } = fixture();

    applyHostEvent({ type: "agent-status", sessionId: "background", running: true }, targets);
    applyHostEvent({ type: "assistant-delta", sessionId: "background", id: "assistant", delta: "hidden" }, targets);

    expect(threadStore.getActivity().runningThreadIds).toEqual(["background"]);
    expect(threadStore.getActivity().isStreaming).toBe(false);
    expect(view.getTranscript().messages).toEqual([]);
  });

  it("does not show a prompt an extension answered itself", () => {
    const { targets, view, registry } = fixture();
    registry.interceptPrompt.mockReturnValue({ confirmed: true } as never);

    applyHostEvent({
      type: "extension-ui-prompt",
      sessionId: "active",
      prompt: { id: "p1", sessionId: "active", kind: "confirm", title: "Continue?" },
    }, targets);

    expect(view.getUiPrompts()).toEqual([]);
  });
});
