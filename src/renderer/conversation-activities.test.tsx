// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { UiMessage, UiTurnActivityEntry } from "../shared/contracts";
import { ThreadViewStore } from "../workbench/thread-view-store";
import { useConversationActivities, type ConversationActivityInput } from "./conversation-activities";
import { ExtensionRegistry, type DesktopExtensionContext, type WorkbenchActions } from "./extension-system";
import type { WorkGroupProps } from "./components/WorkRows";

function inputFor(messages: UiMessage[], history: UiTurnActivityEntry[]): ConversationActivityInput {
  const viewStore = new ThreadViewStore();
  viewStore.beginThread("stream");
  viewStore.setMessages(messages);
  viewStore.setTurnActivityHistory(history);
  return {
    viewStore, registry: new ExtensionRegistry(), pendingNewThread: false, running: true,
    prompts: [], detail: "focused", recoverThread: async () => undefined,
    copyToolOutput: async () => undefined, loadToolOutput: async () => undefined, abort: () => {},
  };
}

describe("historical conversation activities", () => {
  it("keeps historical rows through other-thread publishes and own-thread status and row changes", () => {
    const input = inputFor([{ id: "u", role: "user", text: "Start", timestamp: 1 }], [{
      id: "history", anchorMessageId: "u", status: "completed",
      tools: [{ id: "tool", name: "read", args: {}, status: "done", startedAt: 2, endedAt: 3 }],
    }]);
    input.conversationSnapshot = { sessionId: "stream", isStreaming: false } as NonNullable<ConversationActivityInput["conversationSnapshot"]>;
    let context!: DesktopExtensionContext;
    let rows!: ReturnType<DesktopExtensionContext["registerTranscriptRows"]>;
    input.registry.activate({ id: "data", name: "Data", activate(given) {
      context = given;
      rows = given.registerTranscriptRows("rows");
    } });
    let renders = 0;
    const { result } = renderHook(() => { renders += 1; return useConversationActivities(input); });
    const historical = result.current.transcriptActivities[0];
    const before = renders;
    act(() => { context.setLiveStatus("other", "Waiting"); rows.setRows("other", [{ id: "other", content: null }]); });
    expect(renders).toBe(before);
    expect(result.current.transcriptActivities[0]).toBe(historical);
    act(() => context.setLiveStatus("stream", "Own waiting"));
    expect(result.current.liveStatusLabel).toBe("Own waiting");
    expect(result.current.transcriptActivities[0]).toBe(historical);
    act(() => rows.setRows("stream", [{ id: "own", content: null }]));
    expect(result.current.transcriptActivities.some((row) => row.id === "rows:own")).toBe(true);
    expect(result.current.transcriptActivities[0]).toBe(historical);
    act(() => rows.clear());
    expect(result.current.transcriptActivities).toHaveLength(1);
    act(() => input.registry.deactivate("data"));
    expect(result.current.liveStatusLabel).toBeUndefined();
  });

  it("keeps 1,000 historical groups unchanged through a 150 KB stream in 2,000 turns", () => {
    const messages: UiMessage[] = Array.from({ length: 4_000 }, (_, index) => ({
      id: `message-${index}`, role: index % 2 === 0 ? "user" : "assistant", text: "Settled text", timestamp: index * 10,
    }));
    const history: UiTurnActivityEntry[] = Array.from({ length: 1_000 }, (_, index) => ({
      id: `history-${index}`, anchorMessageId: messages[index * 2].id, status: "completed",
      tools: [{ id: `tool-${index}`, name: "read", args: { path: "file.ts" }, status: "done", startedAt: index * 20 + 1, endedAt: index * 20 + 2 }],
    }));
    const input = inputFor(messages, history);
    input.actions = {} as WorkbenchActions;
    const toolCardFor = vi.spyOn(input.registry, "toolCardFor");
    const { result } = renderHook(() => useConversationActivities(input));
    const original = result.current.transcriptActivities;
    expect(original).toHaveLength(1_000);
    toolCardFor.mockClear();

    for (let frame = 0; frame < 40; frame += 1) {
      act(() => {
        input.viewStore.dispatch({ type: "assistant-delta", sessionId: "stream", id: "message-3999", delta: "x".repeat(3_840) });
        input.viewStore.flushAssistantDeltas();
      });
    }
    expect(input.viewStore.getTranscript().messages.at(-1)!.text.length).toBe("Settled text".length + 153_600);
    expect(result.current.transcriptActivities).toHaveLength(original.length);
    expect(result.current.transcriptActivities.every((row, index) => row === original[index])).toBe(true);
    expect(toolCardFor).not.toHaveBeenCalled();
  });

  it("reuses settled segments when a later turn arrives and rebuilds changed answers", () => {
    const input = inputFor([
      { id: "u", role: "user", text: "Start", timestamp: 1 },
      { id: "a", role: "assistant", text: " ", timestamp: 4 },
    ], [{
      id: "history", anchorMessageId: "u", status: "completed",
      tools: [{ id: "tool", name: "read", args: {}, status: "done", startedAt: 2, endedAt: 3 }],
    }]);
    const { result } = renderHook(() => useConversationActivities(input));
    const props = () => (result.current.transcriptActivities[0].content as ReactElement<WorkGroupProps>).props;
    expect(props().answerAt).toBeUndefined();
    act(() => {
      input.viewStore.dispatch({ type: "assistant-delta", sessionId: "stream", id: "a", delta: "Answer" });
      input.viewStore.flushAssistantDeltas();
    });
    expect(props().answerAt).toBe(4);
    const settled = result.current.transcriptActivities[0];
    act(() => input.viewStore.appendMessage({ id: "next", role: "user", text: "Next turn", timestamp: 5 }));
    expect(result.current.transcriptActivities[0]).toBe(settled);
    act(() => input.viewStore.setMessages([
      { id: "u", role: "user", text: "Start", timestamp: 1 },
      { id: "a", role: "assistant", text: "Answer", timestamp: 10 },
      { id: "next", role: "user", text: "Next turn", timestamp: 11 },
    ]));
    expect(props().answerAt).toBe(10);
  });

  it("refreshes card rows with the current streamed text and responds to registry changes", () => {
    const input = inputFor([{ id: "u", role: "user", text: "Start", timestamp: 1 }], [{
      id: "history", anchorMessageId: "u", status: "completed",
      tools: [{ id: "tool", name: "read", args: {}, status: "done", startedAt: 2, endedAt: 3 }],
    }]);
    input.actions = {} as WorkbenchActions;
    const { result } = renderHook(() => useConversationActivities(input));
    const original = result.current.transcriptActivities[0];
    const rows = vi.fn(({ messages }: { messages: readonly UiMessage[] }) => [{ id: "card-row", content: messages.at(-1)!.text }]);
    act(() => input.registry.activate({ id: "test.card", name: "Card", activate(context) {
      context.registerToolCard({ id: "test.card", match: () => true, Component: () => null, transcriptRows: rows });
    } }));
    expect(result.current.transcriptActivities[0]).not.toBe(original);
    expect(result.current.transcriptActivities.at(-1)!.content).toBe("Start");
    act(() => {
      input.viewStore.dispatch({ type: "assistant-delta", sessionId: "stream", id: "a", delta: "Live answer" });
      input.viewStore.flushAssistantDeltas();
    });
    expect(result.current.transcriptActivities.at(-1)!.content).toBe("Live answer");
    act(() => {
      input.viewStore.dispatch({ type: "assistant-delta", sessionId: "stream", id: "a", delta: " grows" });
      input.viewStore.flushAssistantDeltas();
    });
    expect(result.current.transcriptActivities.at(-1)!.content).toBe("Live answer grows");
  });
});
