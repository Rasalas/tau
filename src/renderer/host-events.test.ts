// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "../shared/contracts";
import { ThreadDetailStore } from "../shared/thread-detail-store";
import { TranscriptMessageIndex } from "../shared/transcript-index";
import { applyHostEvent, type HostEventStores } from "./host-events";
import { ThreadStore } from "./thread-store";

function fixture() {
  const threadStore = new ThreadStore();
  threadStore.setActiveThread("active");
  const messages = { current: [] as HostSnapshot["messages"] };
  const transcriptIndex = { current: new TranscriptMessageIndex([]) };
  const stores = {
    registry: { dispatchWorkbenchEvent: vi.fn(), dispatchExtensionEvent: vi.fn() },
    threadStore,
    detailStore: new ThreadDetailStore(),
    messages,
    transcriptTurnStart: { current: undefined },
    recoveries: { current: new Map() },
    activeDraftKey: { current: undefined },
    assistantStarts: { current: new Map() },
    pendingToolUpdates: { current: new Map() },
    toolFrame: { current: undefined },
    toolAnchor: { current: undefined },
    runningThread: { current: "" },
    assistantAnchors: { current: new Map() },
    transcriptIndex,
    setOptimisticMessages: vi.fn(),
    setTranscriptTurnStart: vi.fn(),
    setNotice: vi.fn(),
    settleNewThreadDelivery: vi.fn(),
    promoteRecoveryToSession: vi.fn(),
    applyHostUpdate: vi.fn(),
    applyThreadIndex: vi.fn(),
    flushAssistantDeltas: vi.fn(),
    flushToolUpdates: vi.fn(),
    updateTools: vi.fn(),
    setToolAnchorId: vi.fn(),
    setTurnActivitySessionId: vi.fn(),
    setSnapshot: vi.fn((update) => { if (typeof update === "function") update(undefined); }),
    setRunStartedAt: vi.fn(),
    appendTranscriptMessage: vi.fn((message) => { transcriptIndex.current.append(message); messages.current = transcriptIndex.current.messages; }),
    queueAssistantDelta: vi.fn(),
    replaceTranscriptMessages: vi.fn(),
    updateTranscriptMessages: vi.fn(),
    setMessages: vi.fn(),
    queueToolUpdate: vi.fn(),
    addEvent: vi.fn(),
    setUiPrompts: vi.fn(),
  } as unknown as HostEventStores;
  return { stores, threadStore };
}

describe("applyHostEvent", () => {
  it("routes host updates through the store boundary", () => {
    const { stores } = fixture();
    const update = { version: 1, type: "project", project: { cwd: "/repo" } } as const;

    applyHostEvent({ type: "host-update", update }, stores);

    expect(stores.applyHostUpdate).toHaveBeenCalledWith(update);
  });

  it("flushes pending tool output when the active run stops", () => {
    const { stores } = fixture();

    applyHostEvent({ type: "agent-status", sessionId: "active", running: false }, stores);

    expect(stores.flushToolUpdates).toHaveBeenCalledOnce();
    expect(stores.flushAssistantDeltas).not.toHaveBeenCalled();
  });

  it("does not project streaming events from a background thread", () => {
    const { stores } = fixture();

    applyHostEvent({ type: "assistant-delta", sessionId: "background", id: "assistant", delta: "hidden" }, stores);

    expect(stores.appendTranscriptMessage).not.toHaveBeenCalled();
    expect(stores.queueAssistantDelta).not.toHaveBeenCalled();
  });
});
