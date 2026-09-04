// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "../../shared/contracts";
import { Composer, normalizeSkillInvocation } from "./Composer";
import { ComposerScopeStore } from "../composer-scope-store";
import type { QueuedFollowUp } from "../follow-up-queue";
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
});
