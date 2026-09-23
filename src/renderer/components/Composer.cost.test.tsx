// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, UiContextUsage, UiThreadUsage } from "../../shared/contracts";
import { Composer } from "./Composer";
import { ComposerScopeStore } from "../../workbench/composer-scope-store";
import { TestProviders } from "../test-support/test-providers";

const snapshot: HostSnapshot = {
  cwd: "/project",
  sessionId: "session",
  sessionTitle: "Thread",
  models: [],
  thinkingLevel: "medium",
  thinkingLevels: ["medium"],
  messages: [],
  isStreaming: false,
  activeTools: [],
  allTools: [],
  extensionCount: 0,
  supportsImageInput: true,
};

const usage: UiThreadUsage = {
  inputTokens: 12_300,
  outputTokens: 2_100,
  cacheReadTokens: 8_000,
  cacheWriteTokens: 0,
  totalTokens: 22_400,
  costUsd: 0.4231,
  turns: 3,
};

function renderComposer(threadUsage?: UiThreadUsage, contextUsage?: UiContextUsage) {
  render(<TestProviders>
    <Composer
      scopeStore={new ComposerScopeStore()}
      snapshot={snapshot}
      queue={[]}
      contextUsage={contextUsage}
      contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
      threadUsage={threadUsage}
      textareaRef={createRef<HTMLTextAreaElement>()}
      onSubmit={vi.fn(async () => ({ accepted: true as const }))}
      onAbort={() => {}}
      onCancelQueued={() => {}}
      onSteerQueued={() => {}}
      onSetModel={() => {}}
      onSetThinking={() => {}}
      onCompactContext={() => {}}
    />
  </TestProviders>);
}

afterEach(cleanup);

describe("composer thread cost", () => {
  it("shows what the thread has spent, and its split when opened", () => {
    renderComposer(usage);
    const button = screen.getByLabelText("Thread cost $0.42");
    expect(button.textContent).toBe("$0.42");

    fireEvent.click(button);
    expect(screen.getByText("12.3k in · 2.1k out · 8.0k cache read · 3 turns")).toBeTruthy();
  });

  it("shows nothing when the cost is unknown", () => {
    renderComposer(undefined);
    expect(screen.queryByLabelText(/^Thread cost/u)).toBeNull();
  });

  it("shows tokens instead of a zero price for a model without pricing", () => {
    renderComposer({ ...usage, costUsd: 0 });
    expect(screen.getByLabelText("Thread cost 22.4k tok")).toBeTruthy();
  });

  it("places cost and context before attachments", () => {
    renderComposer(usage, { tokens: 10_000, contextWindow: 100_000, percent: 10 });
    const cost = screen.getByLabelText("Thread cost $0.42");
    const context = screen.getByLabelText("Context 10 percent used");
    const attachment = screen.getByRole("button", { name: "Attach files" });

    expect(cost.compareDocumentPosition(context) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(context.compareDocumentPosition(attachment) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
