// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "../../shared/contracts";
import { ComposerScopeStore } from "../../workbench/composer-scope-store";
import { TestProviders } from "../test-support/test-providers";
import { PreferencesStore } from "../preferences";
import { Composer } from "./Composer";

const snapshot: HostSnapshot = {
  cwd: "/project",
  sessionId: "session",
  sessionTitle: "Thread",
  models: [],
  thinkingLevel: "off",
  thinkingLevels: [],
  messages: [],
  isStreaming: false,
  activeTools: [],
  allTools: [],
  extensionCount: 0,
};

afterEach(cleanup);

describe("Composer vim and reverse-i-search", () => {
  it("shows reverse-i-search on Ctrl+R and dismisses on Escape", () => {
    const preferences = new PreferencesStore();

    render(
      <TestProviders preferences={preferences}>
        <Composer
          scopeStore={new ComposerScopeStore()}
          snapshot={snapshot}
          queue={[]}
          contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
          textareaRef={createRef<HTMLTextAreaElement>()}
          onSubmit={vi.fn(async () => ({ accepted: true as const }))}
          onAbort={() => {}}
          onCancelQueued={() => {}}
          onSteerQueued={() => {}}
          onSetModel={() => {}}
          onSetThinking={() => {}}
          onCompactContext={() => {}}
        />
      </TestProviders>,
    );

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;

    // Trigger Ctrl+R
    fireEvent.keyDown(textarea, { key: "r", ctrlKey: true });
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText(/reverse-i-search/u)).toBeTruthy();

    // Escape dismisses
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows vim mode badge when enabled and handles mode switching", () => {
    const preferences = new PreferencesStore();
    preferences.setVimMode(true);

    render(
      <TestProviders preferences={preferences}>
        <Composer
          scopeStore={new ComposerScopeStore()}
          snapshot={snapshot}
          queue={[]}
          contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
          textareaRef={createRef<HTMLTextAreaElement>()}
          onSubmit={vi.fn(async () => ({ accepted: true as const }))}
          onAbort={() => {}}
          onCancelQueued={() => {}}
          onSteerQueued={() => {}}
          onSetModel={() => {}}
          onSetThinking={() => {}}
          onCompactContext={() => {}}
        />
      </TestProviders>,
    );

    // Initial state is INSERT mode
    const badge = screen.getByText("INSERT");
    expect(badge).toBeTruthy();

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;

    // Press Escape to enter normal mode
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.getByText("NORMAL")).toBeTruthy();
    expect(textarea.placeholder).toContain("Vim NORMAL mode");

    // Press 'i' to return to insert mode
    fireEvent.keyDown(textarea, { key: "i" });
    expect(screen.getByText("INSERT")).toBeTruthy();
  });
});
