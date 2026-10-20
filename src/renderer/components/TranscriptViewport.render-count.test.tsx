// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiMessage } from "../../shared/contracts";
import type { TranscriptActivity } from "./transcript-activity";
import type { TranscriptTurnNavigationEntry } from "./transcript-turn-navigation";

// Renders of a message's body, by its text; the rows' own Markdown is what a settled answer costs.
const markdownRenders = vi.hoisted(() => new Map<string, number>());
vi.mock("./LazyMarkdown", () => ({
  Markdown: ({ children }: { children: string }) => {
    markdownRenders.set(children, (markdownRenders.get(children) ?? 0) + 1);
    return <span>{children}</span>;
  },
}));
const promptRenders = vi.hoisted(() => new Map<string, number>());
vi.mock("./UserMessage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./UserMessage")>();
  return {
    ...actual,
    UserMessage: (props: Parameters<typeof actual.UserMessage>[0]) => {
      promptRenders.set(props.message.id, (promptRenders.get(props.message.id) ?? 0) + 1);
      return <actual.UserMessage {...props} />;
    },
  };
});
const railEntries = vi.hoisted(() => [] as (readonly TranscriptTurnNavigationEntry[])[]);
vi.mock("./TranscriptTurnNavigation", () => ({
  TranscriptTurnNavigation: ({ entries }: { entries: readonly TranscriptTurnNavigationEntry[] }) => {
    railEntries.push(entries);
    return <nav aria-label="Turns">{entries.length}</nav>;
  },
}));

import { TranscriptViewport } from "./TranscriptViewport";

afterEach(async () => {
  cleanup();
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
});

describe("transcript viewport render isolation", () => {
  it("streams at the tail of many loaded turns without rendering settled rows or rebuilding the turn rail", async () => {
    const settled: UiMessage[] = Array.from({ length: 40 }, (_, turn) => [
      { id: `prompt-${turn}`, role: "user" as const, text: `Question ${turn}`, timestamp: turn * 10 },
      { id: `progress-${turn}`, role: "assistant" as const, text: `Reading ${turn}`, timestamp: turn * 10 + 1 },
      { id: `answer-${turn}`, role: "assistant" as const, text: `Answer ${turn}`, thinking: `Because ${turn}`, timestamp: turn * 10 + 2 },
    ]).flat();
    const tools: TranscriptActivity[] = Array.from({ length: 40 }, (_, turn) => ({
      id: `tools-${turn}`, afterMessageId: `progress-${turn}`, foldWithTurn: true, content: <span>Read {turn}</span>,
    }));
    const prompt: UiMessage = { id: "prompt-live", role: "user", text: "Next question", timestamp: 1_000 };
    const scrollRef = createRef<HTMLDivElement>();
    const onCopy = () => undefined;
    let revision = 0;
    // The store replaces the live record per frame; the activities arrive as a new array of the same rows.
    const frame = (text: string) => <TranscriptViewport
      messages={[...settled, prompt, { id: "live", role: "assistant", text, timestamp: 1_001 }]}
      scrollRef={scrollRef}
      sessionId="thread"
      revision={revision++}
      lookupRevision={1}
      isStreaming
      activities={[...tools]}
      onCopyMessage={onCopy}
    />;
    const view = render(frame("Live"));
    await waitFor(() => expect(railEntries.at(-1)).toHaveLength(41));
    await waitFor(() => expect(markdownRenders.get("Answer 0")).toBeGreaterThan(0));
    const answers = new Map(markdownRenders);
    const prompts = new Map(promptRenders);
    const entries = railEntries.at(-1);

    for (const text of ["Live answer", "Live answer grows", "Live answer grows again"]) {
      view.rerender(frame(text));
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    }

    expect([...answers.keys()].filter((text) => text.startsWith("Answer ")).length).toBeGreaterThan(0);
    for (const [text, count] of answers) if (text.startsWith("Answer ")) expect(markdownRenders.get(text)).toBe(count);
    for (const [id, count] of prompts) if (id !== "prompt-live") expect(promptRenders.get(id)).toBe(count);
    expect(railEntries.every((rendered, index) => index < railEntries.indexOf(entries!) || rendered === entries)).toBe(true);
  });
});
