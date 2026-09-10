// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "../../shared/contracts";
import { ComposerScopeStore } from "../../workbench/composer-scope-store";
import { TestProviders } from "../test-support/test-providers";
import { Composer } from "./Composer";

const snapshot: HostSnapshot = {
  cwd: "/project",
  sessionId: "session",
  sessionTitle: "Thread",
  models: [],
  thinkingLevel: "off",
  thinkingLevels: [],
  messages: [],
  isStreaming: true,
  activeTools: [],
  allTools: [],
  extensionCount: 0,
};

afterEach(cleanup);

describe("prompt controls in the composer", () => {
  it("shows answer and stop actions together and sends typed answers", () => {
    const onAnswerPrompt = vi.fn();
    render(
      <TestProviders>
        <Composer
          scopeStore={new ComposerScopeStore()}
          snapshot={snapshot}
          prompt={{ id: "prompt", sessionId: "session", kind: "input", title: "What next?" }}
          queue={[]}
          contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
          textareaRef={createRef<HTMLTextAreaElement>()}
          onSubmit={vi.fn(async () => ({ accepted: true as const }))}
          onAbort={() => {}}
          onCancelQueued={() => {}}
          onSteerQueued={() => {}}
          onReorderQueue={() => {}}
          onSetModel={() => {}}
          onSetThinking={() => {}}
          onAnswerPrompt={onAnswerPrompt}
          onCompactContext={() => {}}
        />
      </TestProviders>,
    );

    const send = screen.getByRole("button", { name: "Send answer" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Stop the run" })).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/Answer yourself/u), { target: { value: "Continue" } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(onAnswerPrompt).toHaveBeenCalledWith("Continue", true);
  });
});
