// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "../../shared/contracts";
import { Composer } from "./Composer";
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
  queueHandlers: { queue?: QueuedFollowUp[]; onSteerQueued?: (id: string) => void; onReorderQueue?: (id: string, toIndex: number) => void; onCancelQueued?: (id: string) => void } = {},
  handlers: { onRunShellAction?: (command: string) => Promise<unknown>; onOpenPromptEditor?: () => void; onNotify?: (msg: string) => void } = {},
) {
  const scopeStore = new ComposerScopeStore();
  render(<TestProviders>
    <Composer
      scopeStore={scopeStore}
      snapshot={{ ...snapshotOverride, isStreaming: streaming }}
      queue={queueHandlers.queue ?? []}
      contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
      textareaRef={createRef<HTMLTextAreaElement>()}
      onSubmit={onSubmit}
      onAbort={() => {}}
      onCancelQueued={queueHandlers.onCancelQueued ?? (() => {})}
      onSteerQueued={queueHandlers.onSteerQueued ?? (() => {})}
      onReorderQueue={queueHandlers.onReorderQueue ?? (() => {})}
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

  it("steers, drops and reorders queued messages from their row", () => {
    const onSteerQueued = vi.fn();
    const onCancelQueued = vi.fn();
    const onReorderQueue = vi.fn();
    renderComposer(vi.fn(async () => ({ accepted: true as const })), true, snapshot, {
      queue: [queued("first", "after this turn"), queued("second", "and then this")],
      onSteerQueued,
      onCancelQueued,
      onReorderQueue,
    });
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.querySelector("span")?.textContent)).toEqual(["after this turn", "and then this"]);

    fireEvent.click(within(rows[1]!).getByRole("button", { name: "Steer" }));
    expect(onSteerQueued).toHaveBeenCalledWith("second");
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "Drop this queued message" }));
    expect(onCancelQueued).toHaveBeenCalledWith("first");

    fireEvent.keyDown(within(rows[0]!).getByRole("button", { name: /Reorder queued message 1/u }), { key: "ArrowDown", altKey: true });
    expect(onReorderQueue).toHaveBeenCalledWith("first", 1);
    fireEvent.pointerDown(within(rows[1]!).getByRole("button", { name: /Reorder queued message 2/u }));
    fireEvent.dragStart(rows[1]!, { dataTransfer: { setData: () => {}, effectAllowed: "" } });
    fireEvent.dragOver(rows[0]!, { dataTransfer: { dropEffect: "" } });
    fireEvent.drop(rows[0]!, { dataTransfer: {} });
    expect(onReorderQueue).toHaveBeenLastCalledWith("second", 0);
  });

  it("keeps a blocking question attached to its answer field below the queue", () => {
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
      onReorderQueue={() => {}}
      onSetModel={() => {}}
      onSetThinking={() => {}}
      prompt={{ id: "question", sessionId: "session", kind: "input", title: "Choose the scope" }}
      onCompactContext={() => {}}
    /></TestProviders>);

    const stack = container.querySelector(".composer-surface");
    expect(Array.from(stack?.children ?? []).slice(0, 3).map((element) => element.classList[0]))
      .toEqual(["composer-queue", "extension-prompt", "composer-frame"]);
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
            onReorderQueue={() => {}}
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

  it("opens model picker when tau:open-model-picker event is dispatched", async () => {
    const snapshotWithModels: HostSnapshot = {
      ...snapshot,
      models: [{ provider: "anthropic", id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet" }],
      model: { provider: "anthropic", id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet" },
    };
    renderComposer(undefined, false, snapshotWithModels);

    window.dispatchEvent(new CustomEvent("tau:open-model-picker"));
    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /model/iu })).toBeTruthy();
    });
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
      expect(onRunShellAction).toHaveBeenCalledWith("ls -la");
    });
    expect(onSubmit).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(onNotify).toHaveBeenCalledWith("file1.txt\nfile2.txt");
    });
    expect(textarea.value).toBe("");
  });

  it("triggers onOpenPromptEditor when external editor button is clicked", () => {
    const onOpenPromptEditor = vi.fn();
    renderComposer(undefined, false, snapshot, {}, { onOpenPromptEditor });

    const editorBtn = screen.getByRole("button", { name: "Edit prompt in external editor" });
    fireEvent.click(editorBtn);

    expect(onOpenPromptEditor).toHaveBeenCalled();
  });
});
