// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUiPrompt, HostSnapshot } from "../../shared/contracts";
import { ComposerScopeStore } from "../../workbench/composer-scope-store";
import { TestProviders } from "../test-support/test-providers";
import { WorkbenchShellContext } from "../workbench-context";
import { Composer } from "./Composer";
import { usePromptSubmit } from "./ExtensionPrompt";

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

    fireEvent.change(screen.getByPlaceholderText(/Answer in text/u), { target: { value: "Continue" } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(onAnswerPrompt).toHaveBeenCalledWith("Continue", true);
  });

  it("sends the files waiting in the composer with a typed answer, or alone, and keeps them from a choice", async () => {
    const onAnswerPrompt = vi.fn();
    const onSubmit = vi.fn(async () => ({ accepted: true as const }));
    const scopeStore = new ComposerScopeStore();
    const view = (prompt: ExtensionUiPrompt) => (
      <TestProviders>
        <Composer
          scopeStore={scopeStore}
          snapshot={{ ...snapshot, supportsImageInput: true }}
          prompt={prompt}
          queue={[]}
          contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
          textareaRef={createRef<HTMLTextAreaElement>()}
          onSubmit={onSubmit}
          onAbort={() => {}}
          onCancelQueued={() => {}}
          onSteerQueued={() => {}}
          onSetModel={() => {}}
          onSetThinking={() => {}}
          onAnswerPrompt={onAnswerPrompt}
          onCompactContext={() => {}}
        />
      </TestProviders>
    );
    const approval: ExtensionUiPrompt = { id: "approve", sessionId: "session", kind: "select", title: "Run it?", options: ["Allow", "Deny"] };
    const { rerender } = render(view(approval));
    const attach = async (name: string) => {
      fireEvent.change(screen.getByLabelText("Choose attachment files"), { target: { files: [new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" })] } });
      await screen.findByRole("button", { name: `Preview ${name}` });
    };
    await attach("shot.png");
    // A pick among fixed choices takes no files; an image alone does not answer it.
    expect((screen.getByRole("button", { name: "Send answer" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Or type an answer below")).toBeTruthy();

    rerender(view({ id: "why", sessionId: "session", kind: "input", title: "Why?" }));
    expect(screen.getByText("Type your answer below; attached files go with it")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/Answer in text/u), { target: { value: "Because" } });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(onAnswerPrompt).toHaveBeenCalledOnce());
    expect(onAnswerPrompt.mock.calls[0]).toEqual(["Because", true, [expect.objectContaining({ kind: "image", name: "shot.png" })]]);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Preview shot.png" })).toBeNull());
    expect(onSubmit).not.toHaveBeenCalled();

    rerender(view({ id: "more", sessionId: "session", kind: "input", title: "Anything else?" }));
    await attach("second.png");
    const send = screen.getByRole("button", { name: "Send answer" }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(onAnswerPrompt).toHaveBeenCalledTimes(2));
    expect(onAnswerPrompt.mock.calls[1]).toEqual(["", true, [expect.objectContaining({ name: "second.png" })]]);
  });

  it("answers the question a prompt still in flight asked, with its files", async () => {
    const onAnswerPrompt = vi.fn();
    // The prompt that runs the asking command settles only once the question is answered.
    const onSubmit = vi.fn(() => new Promise<{ accepted: true }>(() => {}));
    const scopeStore = new ComposerScopeStore();
    const view = (prompt?: ExtensionUiPrompt) => (
      <TestProviders>
        <Composer
          scopeStore={scopeStore}
          snapshot={{ ...snapshot, isStreaming: false, supportsImageInput: true }}
          {...(prompt ? { prompt } : {})}
          queue={[]}
          contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
          textareaRef={createRef<HTMLTextAreaElement>()}
          onSubmit={onSubmit}
          onAbort={() => {}}
          onCancelQueued={() => {}}
          onSteerQueued={() => {}}
          onSetModel={() => {}}
          onSetThinking={() => {}}
          onAnswerPrompt={onAnswerPrompt}
          onCompactContext={() => {}}
        />
      </TestProviders>
    );
    const { rerender } = render(view());
    fireEvent.change(screen.getByPlaceholderText(/./u), { target: { value: "/ask" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());

    rerender(view({ id: "why", sessionId: "session", kind: "input", title: "Why?" }));
    fireEvent.change(screen.getByLabelText("Choose attachment files"), { target: { files: [new File([new Uint8Array([137, 80, 78, 71])], "late.png", { type: "image/png" })] } });
    await screen.findByRole("button", { name: "Preview late.png" });
    fireEvent.change(screen.getByPlaceholderText(/Answer in text/u), { target: { value: "Here" } });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(onAnswerPrompt).toHaveBeenCalledWith("Here", true, [expect.objectContaining({ name: "late.png" })]));
  });

  it("keeps a question the agent asks mid-typing closed until the typing stops, then sets the draft aside until the answer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const onAnswerPrompt = vi.fn();
      const onSubmit = vi.fn(async () => ({ accepted: true as const }));
      const scopeStore = new ComposerScopeStore();
      const view = (prompt?: ExtensionUiPrompt) => (
        <TestProviders>
          <Composer
            scopeStore={scopeStore}
            snapshot={snapshot}
            {...(prompt ? { prompt } : {})}
            queue={[]}
            contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
            textareaRef={createRef<HTMLTextAreaElement>()}
            onSubmit={onSubmit}
            onAbort={() => {}}
            onCancelQueued={() => {}}
            onSteerQueued={() => {}}
            onSetModel={() => {}}
            onSetThinking={() => {}}
            onAnswerPrompt={onAnswerPrompt}
            onCompactContext={() => {}}
          />
        </TestProviders>
      );
      const { rerender } = render(view());
      const field = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.keyDown(field, { key: "x" });
      fireEvent.change(field, { target: { value: "half a thought" } });

      rerender(view({ id: "pick", sessionId: "session", kind: "select", title: "Which one?", options: ["A", "B"] }));
      expect(screen.getByText(/opens once you stop typing/u)).toBeTruthy();
      // Enter meant for the draft neither answers nor sends.
      fireEvent.keyDown(field, { key: "Enter" });
      expect(onAnswerPrompt).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();
      expect(field.value).toBe("half a thought");

      await vi.advanceTimersByTimeAsync(1600);
      await waitFor(() => expect(field.value).toBe(""));
      expect(screen.getByText(/draft is set aside/u)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /B$/u }));
      expect(onAnswerPrompt).toHaveBeenCalledWith("B", undefined);

      rerender(view());
      await waitFor(() => expect(field.value).toBe("half a thought"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens a question at once while the user is not typing, and gives a waiting draft back after it", async () => {
    const scopeStore = new ComposerScopeStore();
    const view = (prompt?: ExtensionUiPrompt) => (
      <TestProviders>
        <Composer
          scopeStore={scopeStore}
          snapshot={snapshot}
          {...(prompt ? { prompt } : {})}
          queue={[]}
          contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
          textareaRef={createRef<HTMLTextAreaElement>()}
          onSubmit={vi.fn(async () => ({ accepted: true as const }))}
          onAbort={() => {}}
          onCancelQueued={() => {}}
          onSteerQueued={() => {}}
          onSetModel={() => {}}
          onSetThinking={() => {}}
          onAnswerPrompt={() => {}}
          onCompactContext={() => {}}
        />
      </TestProviders>
    );
    const { rerender } = render(view());
    const field = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "left here earlier" } });

    rerender(view({ id: "why", sessionId: "session", kind: "input", title: "Why?" }));
    await waitFor(() => expect(field.value).toBe(""));
    expect(screen.queryByText(/opens once you stop typing/u)).toBeNull();
    fireEvent.change(field, { target: { value: "because" } });

    rerender(view());
    await waitFor(() => expect(field.value).toBe("left here earlier\nbecause"));
  });

  it("submits registered prompt actions from the composer button and on Enter", () => {
    const onSubmit = vi.fn();
    function CustomPrompt() {
      usePromptSubmit("Send 2", false, onSubmit);
      return <div>Custom prompt</div>;
    }

    render(
      <TestProviders>
        <WorkbenchShellContext.Provider
          value={{
            snapshot,
            registry: {
              getPromptRenderer: () => ({ id: "custom", match: () => true, Component: CustomPrompt }),
              getSlashCommands: () => [],
              getComposerControls: () => [],
              getComposerInlines: () => [],
              streamingDelivery: () => undefined,
              subscribe: () => () => {},
              getVersion: () => 1,
            } as never,
          }}
        >
          <Composer
            scopeStore={new ComposerScopeStore()}
            snapshot={snapshot}
            prompt={{ id: "custom-prompt", sessionId: "session", kind: "input", title: "Pick?" }}
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
        </WorkbenchShellContext.Provider>
      </TestProviders>,
    );

    const send = screen.getByRole("button", { name: "Send 2" }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    const textarea = screen.getByPlaceholderText(/Answer in text/u);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
});
