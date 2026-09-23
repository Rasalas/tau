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

    fireEvent.change(screen.getByPlaceholderText(/Answer yourself/u), { target: { value: "Continue" } });
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
    expect(screen.getByText(/or answer below$/u)).toBeTruthy();

    rerender(view({ id: "why", sessionId: "session", kind: "input", title: "Why?" }));
    expect(screen.getByText("answer below; attached files go with it")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/Answer yourself/u), { target: { value: "Because" } });
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

    const textarea = screen.getByPlaceholderText(/Answer yourself/u);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
});
