// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "../../shared/contracts";
import { Composer, type ComposerControlHandle } from "./Composer";
import { ComposerScopeStore } from "../../workbench/composer-scope-store";
import type { QueuedFollowUp } from "../../workbench/follow-up-queue";
import { ExtensionRegistry } from "../extension-system";
import { WorkbenchShellContext } from "../workbench-context";
import { TestProviders } from "../test-support/test-providers";

const queued = (id: string, text: string): QueuedFollowUp => ({ id, text, attachments: [] });

const composerCommands = [
  { name: "skill:tdd", description: "Build features test-first", source: "skill" as const, skillCommand: "/skill:tdd" },
  { name: "review", description: "Review staged changes", argumentHint: "[scope]", source: "prompt" as const },
  { name: "reload", description: "Reload resources", source: "extension" as const },
];

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
  composerCommands,
  extensionCount: 0,
  supportsImageInput: true,
};

function renderComposer(
  onSubmit = vi.fn(async () => ({ accepted: true as const })),
  streaming = false,
  snapshotOverride: HostSnapshot = snapshot,
  queueHandlers: { queue?: QueuedFollowUp[]; onSteerQueued?: (id: string) => void; onCancelQueued?: (id: string) => void } = {},
  handlers: { onRunShellAction?: (command: string) => Promise<unknown>; onOpenPromptEditor?: () => void; onNotify?: (msg: string) => void } = {},
  controlRef?: React.RefObject<ComposerControlHandle | null>,
) {
  const scopeStore = new ComposerScopeStore();
  render(<TestProviders>
    <Composer
      scopeStore={scopeStore}
      snapshot={{ ...snapshotOverride, isStreaming: streaming }}
      queue={queueHandlers.queue ?? []}
      contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
      textareaRef={createRef<HTMLTextAreaElement>()}
      controlRef={controlRef}
      onSubmit={onSubmit}
      onAbort={() => {}}
      onCancelQueued={queueHandlers.onCancelQueued ?? (() => {})}
      onSteerQueued={queueHandlers.onSteerQueued ?? (() => {})}
      onSetModel={() => {}}
      onSetThinking={() => {}}
      onCompactContext={() => {}}
      onRunShellAction={handlers.onRunShellAction}
      onOpenPromptEditor={handlers.onOpenPromptEditor}
      onNotify={handlers.onNotify}
    />
  </TestProviders>);
  return onSubmit;
}

afterEach(cleanup);

describe("Composer command menu", () => {
  it("grows and shrinks with multiline input", async () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    let scrollHeight = 118;
    Object.defineProperty(textarea, "scrollHeight", { configurable: true, get: () => scrollHeight });

    fireEvent.change(textarea, { target: { value: "first\nsecond\nthird", selectionStart: 18 } });
    await waitFor(() => expect(textarea.style.height).toBe("118px"));

    scrollHeight = 46;
    fireEvent.change(textarea, { target: { value: "short", selectionStart: 5 } });
    await waitFor(() => expect(textarea.style.height).toBe("46px"));
  });

  it("shows skills with the $ syntax and sends the user's shorthand unchanged", () => {
    const onSubmit = renderComposer();
    const textarea = screen.getByPlaceholderText(/\$ skills/u) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "$td", selectionStart: 3 } });
    expect(screen.getByRole("listbox", { name: "Skills" })).toBeTruthy();
    expect(screen.getByRole("option", { name: /tdd/u })).toBeTruthy();

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("$tdd ");
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(textarea, { target: { value: "$tdd fix the parser", selectionStart: 19 } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("$tdd fix the parser", [], undefined, { source: "skill", name: "tdd", visibleText: "fix the parser", command: "/skill:tdd" });
  });

  it("finds and executes skills directly from slash", () => {
    const onSubmit = renderComposer();
    const textarea = screen.getByPlaceholderText(/\/ commands/u) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/td", selectionStart: 3 } });
    expect(screen.getByRole("option", { name: /tdd/u }).textContent).not.toContain("skill:tdd");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("/tdd ");

    fireEvent.change(textarea, { target: { value: "/tdd fix the parser", selectionStart: 19 } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("/tdd fix the parser", [], undefined, { source: "skill", name: "tdd", visibleText: "fix the parser", command: "/skill:tdd" });
  });

  it("queues Enter and steers with Command-Enter while streaming", async () => {
    const onSubmit = renderComposer(vi.fn(async () => ({ accepted: true as const })), true);
    const textarea = screen.getByPlaceholderText(/queues/u) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "after this turn", selectionStart: 15 } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenLastCalledWith("after this turn", [], "followUp");
    await new Promise((resolve) => setTimeout(resolve, 0));

    fireEvent.change(textarea, { target: { value: "adjust now", selectionStart: 10 } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenLastCalledWith("adjust now", [], "steer");
  });

  it("sends with the modifier held as the alternate send while idle", async () => {
    const onSubmit = renderComposer(vi.fn(async () => ({ accepted: true as const })));
    const textarea = screen.getByPlaceholderText(/\/ commands/u) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "start it elsewhere", selectionStart: 18 } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenLastCalledWith("start it elsewhere", [], "alternate");
  });

  it("releases the head of the queue with Command-Enter on an empty field", () => {
    const onSteerQueued = vi.fn();
    const onSubmit = renderComposer(vi.fn(async () => ({ accepted: true as const })), true, snapshot, {
      queue: [queued("first", "after this turn"), queued("second", "and then this")],
      onSteerQueued,
    });
    const textarea = screen.getByPlaceholderText(/queues/u) as HTMLTextAreaElement;

    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    expect(onSteerQueued).toHaveBeenCalledWith("first");
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(textarea, { target: { value: "typed instead", selectionStart: 13 } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenLastCalledWith("typed instead", [], "steer");
    expect(onSteerQueued).toHaveBeenCalledTimes(1);
  });

  it("sends the oldest queued message with Command-Shift-Enter and leaves the draft", () => {
    const onSteerQueued = vi.fn();
    const onSubmit = renderComposer(vi.fn(async () => ({ accepted: true as const })), true, snapshot, {
      queue: [queued("first", "after this turn"), queued("second", "and then this")],
      onSteerQueued,
    });
    const textarea = screen.getByPlaceholderText(/queues/u) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "still typing", selectionStart: 12 } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true, shiftKey: true });
    expect(onSteerQueued).toHaveBeenCalledWith("first");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea.value).toBe("still typing");
  });

  it("keeps a blocking question attached to its answer field", () => {
    const { container } = render(<TestProviders><Composer
      snapshot={{ ...snapshot, isStreaming: true }}
      scopeStore={new ComposerScopeStore()}
      queue={[queued("first", "after this turn")]}
      contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
      textareaRef={createRef<HTMLTextAreaElement>()}
      onSubmit={async () => ({ accepted: true as const })}
      onAbort={() => {}}
      onCancelQueued={() => {}}
      onSteerQueued={() => {}}
      onSetModel={() => {}}
      onSetThinking={() => {}}
      prompt={{ id: "question", sessionId: "session", kind: "input", title: "Choose the scope" }}
      onCompactContext={() => {}}
    /></TestProviders>);

    const stack = container.querySelector(".composer-surface");
    expect(Array.from(stack?.children ?? []).slice(0, 2).map((element) => element.classList[0]))
      .toEqual(["extension-prompt", "composer-frame"]);
  });

  it("keeps the slash menu closed for a token after Escape, and opens it for the next one", () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText(/\/ commands/u) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "/rev", selectionStart: 4 } });
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeTruthy();
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
    fireEvent.change(textarea, { target: { value: "/revi", selectionStart: 5 } });
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
    fireEvent.change(textarea, { target: { value: "", selectionStart: 0 } });
    fireEvent.change(textarea, { target: { value: "/re", selectionStart: 3 } });
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeTruthy();
  });

  it("offers prompt templates and extension commands under slash", () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText(/\/ commands/u) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/rev", selectionStart: 4 } });
    const menu = screen.getByRole("listbox", { name: "Commands" });
    expect(menu.textContent).toContain("review");
    expect(menu.textContent).toContain("[scope]");
    expect(menu.textContent).not.toContain("tdd");

    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(textarea.value).toBe("/review ");
  });

  it("passes indented command-looking Markdown to the host unchanged", () => {
    const onSubmit = renderComposer();
    const textarea = screen.getByPlaceholderText(/\/ commands/u) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "    /tdd keep this code", selectionStart: 23 } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("    /tdd keep this code", []);
  });

  it("passes selected skill metadata while preserving instruction indentation", () => {
    const onSubmit = renderComposer();
    const textarea = screen.getByPlaceholderText(/\$ skills/u) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "$td", selectionStart: 3 } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.change(textarea, { target: { value: "$tdd  keep this:\n    code", selectionStart: 25 } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith(
      "$tdd  keep this:\n    code",
      [],
      undefined,
      { source: "skill", name: "tdd", visibleText: " keep this:\n    code", command: "/skill:tdd" },
    );
  });

  it("makes unsupported Claude controls unavailable before invocation", () => {
    renderComposer(vi.fn(), false, {
      ...snapshot,
      backendKind: "claude-code",
      runtimeCapabilities: { skillInvocationDialect: "claude-code", ownsModelSelection: true, interactiveApprovals: false },
      models: [],
      model: undefined,
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      });

    expect(screen.getByRole("button", { name: "Model selection unavailable" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Reasoning controls unavailable" })).toHaveProperty("disabled", true);
  });

  it("navigates prompt history with ArrowUp and ArrowDown", async () => {
    const onSubmit = renderComposer();
    const textarea = screen.getByPlaceholderText(/\/ commands/u) as HTMLTextAreaElement;

    // Send first prompt
    fireEvent.change(textarea, { target: { value: "first prompt", selectionStart: 12 } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("first prompt", []);
    // Allow async sendSubmission to settle and record in prompt history
    await waitFor(() => expect(textarea.value).toBe(""));

    // Type a draft
    fireEvent.change(textarea, { target: { value: "draft in progress", selectionStart: 0, selectionEnd: 0 } });
    textarea.setSelectionRange(0, 0);

    // ArrowUp loads previous prompt
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("first prompt");

    // ArrowDown restores the draft in progress
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea.value).toBe("draft in progress");
  });

  it("offers @file autocomplete and inserts selected file into the composer", async () => {
    const registry = new ExtensionRegistry();
    registry.activate({
      id: "test-docs",
      name: "Test Docs",
      activate(context) {
        context.registerDocumentSource({
          id: "test-docs",
          loadFile: async (path: string) => ({ path, name: "a", size: 0, kind: "text" as const, text: "" }),
          loadDiff: async (path: string) => ({ path, added: 0, removed: 0, hunks: [] }),
          openInEditor: () => undefined,
          getState: () => ({ changes: { files: [], added: 0, removed: 0 } }),
          subscribe: () => () => undefined,
          listFiles: async () => ["src/index.ts", "src/utils.ts", "README.md"],
        });
      },
    });

    const onSubmit = vi.fn(async () => ({ accepted: true as const }));
    const scopeStore = new ComposerScopeStore();
    render(
      <TestProviders>
        <WorkbenchShellContext.Provider value={{ registry, snapshot }}>
          <Composer
            scopeStore={scopeStore}
            snapshot={snapshot}
            queue={[]}
            contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
            textareaRef={createRef<HTMLTextAreaElement>()}
            onSubmit={onSubmit}
            onAbort={() => {}}
            onCancelQueued={() => {}}
            onSteerQueued={() => {}}
            onSetModel={() => {}}
            onSetThinking={() => {}}
            onCompactContext={() => {}}
          />
        </WorkbenchShellContext.Provider>
      </TestProviders>
    );

    const textarea = screen.getByPlaceholderText(/\/ commands/u) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "@ut", selectionStart: 3 } });

    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: "Files" })).toBeTruthy();
    });

    expect(screen.getByRole("option", { name: /src\/utils\.ts/u })).toBeTruthy();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("@src/utils.ts ");
  });

  it("opens model picker through its control handle when available", async () => {
    const snapshotWithModels: HostSnapshot = {
      ...snapshot,
      models: [{ provider: "anthropic", id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet" }],
      model: { provider: "anthropic", id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet" },
    };
    const controlRef = createRef<ComposerControlHandle>();
    renderComposer(undefined, false, snapshotWithModels, {}, {}, controlRef);

    act(() => controlRef.current?.openModelPicker());
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /model/iu })).toBeTruthy();
    });
  });

  it("does not open model picker through its control handle when unavailable", () => {
    const controlRef = createRef<ComposerControlHandle>();
    renderComposer(undefined, false, snapshot, {}, {}, controlRef);

    act(() => controlRef.current?.openModelPicker());
    expect(screen.queryByRole("dialog", { name: /model/iu })).toBeNull();
  });

  it("autocompletes /model arguments from snapshot models", async () => {
    const snapshotWithModels: HostSnapshot = {
      ...snapshot,
      models: [
        { provider: "anthropic", id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet" },
        { provider: "openai", id: "gpt-5", name: "GPT-5" },
      ],
    };
    renderComposer(undefined, false, snapshotWithModels);
    const textarea = screen.getByPlaceholderText(/\/ commands/u) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/model cl", selectionStart: 9 } });
    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: "model arguments" })).toBeTruthy();
    });

    expect(screen.getByRole("option", { name: /anthropic\/claude-3-7-sonnet/u })).toBeTruthy();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("/model anthropic/claude-3-7-sonnet ");
  });

  it("autocompletes /thinking arguments with valid levels", async () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText(/\/ commands/u) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/thinking h", selectionStart: 11 } });
    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: "thinking arguments" })).toBeTruthy();
    });

    expect(screen.getByRole("option", { name: /high/u })).toBeTruthy();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("/thinking high ");
  });

  it("executes direct shell action when prompt starts with ! and skips onSubmit", async () => {
    const onSubmit = vi.fn(async () => ({ accepted: true as const }));
    const onRunShellAction = vi.fn(async () => ({ output: "file1.txt\nfile2.txt", exitCode: 0 }));
    const onNotify = vi.fn();

    renderComposer(onSubmit, false, snapshot, {}, { onRunShellAction, onNotify });
    const textarea = screen.getByPlaceholderText(/\/ commands/u) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "!ls -la", selectionStart: 7 } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(onRunShellAction).toHaveBeenCalledWith("ls -la", true);
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onNotify).not.toHaveBeenCalled();
    expect(textarea.value).toBe("");
  });

  it("executes silent shell action when prompt starts with !! and skips redundant toast", async () => {
    const onSubmit = vi.fn(async () => ({ accepted: true as const }));
    const onRunShellAction = vi.fn(async () => ({ output: "silent.txt", exitCode: 0 }));
    const onNotify = vi.fn();

    renderComposer(onSubmit, false, snapshot, {}, { onRunShellAction, onNotify });
    const textarea = screen.getByPlaceholderText(/\/ commands/u) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "!!ls -la", selectionStart: 8 } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(onRunShellAction).toHaveBeenCalledWith("ls -la", false);
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onNotify).not.toHaveBeenCalled();
    expect(textarea.value).toBe("");
  });

  it("keeps editor actions off the toolbar and opens the external editor with its shortcut", () => {
    const onOpenPromptEditor = vi.fn();
    renderComposer(undefined, false, snapshot, {}, { onOpenPromptEditor });

    expect(screen.queryByRole("button", { name: "Expand composer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit prompt in external editor" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "e", metaKey: true });

    expect(onOpenPromptEditor).toHaveBeenCalled();
  });

  it("displays shell chip and updates placeholder when input starts with ! or !!", () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText(/\/ commands/u) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "!git status", selectionStart: 11 } });
    expect(screen.getByText("Shell")).toBeTruthy();
    expect(screen.getByPlaceholderText(/Shell mode — runs command and shares output/u)).toBeTruthy();

    fireEvent.change(textarea, { target: { value: "!!git status", selectionStart: 12 } });
    expect(screen.getByText("Silent Shell")).toBeTruthy();
    expect(screen.getByPlaceholderText(/Silent shell mode — runs command without LLM context/u)).toBeTruthy();
  });

  it("restores queued message into editor when Alt+Up or Alt+Q is pressed", () => {
    const onCancelQueued = vi.fn();
    renderComposer(undefined, false, snapshot, {
      queue: [queued("q1", "queued prompt text")],
      onCancelQueued,
    });
    const textarea = screen.getByPlaceholderText(/\/ commands/u) as HTMLTextAreaElement;

    fireEvent.keyDown(textarea, { key: "ArrowUp", altKey: true });
    expect(onCancelQueued).toHaveBeenCalledWith("q1");
    expect(textarea.value).toBe("queued prompt text");
  });

  it("updates editor text when tau:composer-editor-action event is received", async () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText(/\/ commands/u) as HTMLTextAreaElement;

    window.dispatchEvent(new CustomEvent("tau:composer-editor-action", {
      detail: { type: "set", text: "text from extension" },
    }));
    await waitFor(() => {
      expect(textarea.value).toBe("text from extension");
    });

    window.dispatchEvent(new CustomEvent("tau:composer-editor-action", {
      detail: { type: "paste", text: "more text" },
    }));
    await waitFor(() => {
      expect(textarea.value).toBe("text from extension\nmore text");
    });
  });

  it("expands @file mentions when submitted", async () => {
    const onSubmit = vi.fn(async () => ({ accepted: true as const }));
    const documentSource = {
      id: "workspace.documents",
      loadFile: vi.fn(async (path: string) => ({
        path,
        name: "test.ts",
        size: 20,
        kind: "text" as const,
        text: "const a = 1;",
      })),
      loadDiff: vi.fn(),
      openInEditor: vi.fn(),
      getState: () => ({ changes: { files: [] } }),
      subscribe: () => () => {},
    };
    const registry = new ExtensionRegistry();
    registry.activate({
      id: "test.doc-source",
      name: "Doc Source",
      activate(context) {
        context.registerDocumentSource(documentSource as any);
      },
    });

    const scopeStore = new ComposerScopeStore();
    render(
      <TestProviders>
        <WorkbenchShellContext.Provider value={{ registry, snapshot }}>
          <Composer
            scopeStore={scopeStore}
            snapshot={snapshot}
            queue={[]}
            contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
            textareaRef={createRef<HTMLTextAreaElement>()}
            onSubmit={onSubmit}
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

    const textarea = screen.getByPlaceholderText(/\/ commands/u) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "inspect @test.ts", selectionStart: 16 } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalled();
    });
    const calledText = (onSubmit.mock.calls as unknown as [string, ...unknown[]][])[0][0];
    expect(calledText).toContain("inspect @test.ts");
    expect(calledText).toContain('<file name="test.ts">\nconst a = 1;\n</file>');
  });
});
