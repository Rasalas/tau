// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, UiQueuedMessage } from "../../shared/contracts";
import { ComposerScopeStore } from "../../workbench/composer-scope-store";
import { ExtensionRegistry, type WorkbenchActions } from "../extension-system";
import { TestProviders } from "../test-support/test-providers";
import { WorkbenchShellContext } from "../workbench-context";
import { Composer } from "./Composer";

afterEach(cleanup);

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

type Options = {
  onSubmit?: () => Promise<{ accepted: true }>;
  streaming?: boolean;
  held?: boolean;
  queue?: UiQueuedMessage[];
  onOpenQueue?: () => void;
  onNotify?: (message: string) => void;
  registry?: ExtensionRegistry;
  actions?: Partial<WorkbenchActions>;
};

function renderComposer({ onSubmit = async () => ({ accepted: true as const }), streaming = false, held = false, queue = [], onOpenQueue, onNotify, registry, actions }: Options = {}) {
  const composer = (
    <Composer
      scopeStore={new ComposerScopeStore()}
      snapshot={{ ...snapshot, isStreaming: streaming }}
      queue={queue}
      contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
      textareaRef={createRef<HTMLTextAreaElement>()}
      onSubmit={onSubmit}
      onAbort={() => {}}
      onCancelQueued={() => {}}
      onSteerQueued={() => {}}
      onOpenQueue={onOpenQueue}
      onSetModel={() => {}}
      onSetThinking={() => {}}
      onCompactContext={() => {}}
      held={held}
      onNotify={onNotify}
    />
  );
  render(<TestProviders>
    {registry ? <WorkbenchShellContext.Provider value={{ registry, ...(actions ? { actions: actions as WorkbenchActions } : {}) }}>{composer}</WorkbenchShellContext.Provider> : composer}
  </TestProviders>);
}

const field = () => screen.getByPlaceholderText(/Ask anything|queue a follow-up/u) as HTMLTextAreaElement;
const sendButton = () => document.querySelector<HTMLButtonElement>(".send-button:not(.stop)")!;
const iconOf = (button: HTMLElement) => [...(button.querySelector("svg")?.classList ?? [])].find((name) => name !== "lucide" && name.startsWith("lucide-"));

describe("a send that cannot go yet", () => {
  it("says why in the button's tooltip, and again when a key is pressed anyway", () => {
    const onNotify = vi.fn();
    const onSubmit = vi.fn(async () => ({ accepted: true as const }));
    renderComposer({ held: true, onNotify, onSubmit });

    // Nothing to send yet: the key says nothing, the button already tells.
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onNotify).not.toHaveBeenCalled();

    fireEvent.change(field(), { target: { value: "hello", selectionStart: 5 } });
    expect(sendButton().disabled).toBe(true);
    expect(sendButton().dataset.tooltip).toBe("A workspace change is under way. Sending waits until it is done.");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onNotify).toHaveBeenCalledWith("A workspace change is under way. Sending waits until it is done.");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("puts the notice on the toast stack under one id, so a held key does not pile them up", () => {
    const toast = vi.fn();
    const onNotify = vi.fn();
    renderComposer({ held: true, onNotify, registry: new ExtensionRegistry(), actions: { toast } });

    fireEvent.change(field(), { target: { value: "hello", selectionStart: 5 } });
    fireEvent.keyDown(field(), { key: "Enter" });
    fireEvent.keyDown(field(), { key: "Enter" });

    expect(toast).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenLastCalledWith({ id: "composer.send-blocked", title: "A workspace change is under way. Sending waits until it is done." });
    expect(onNotify).not.toHaveBeenCalled();
  });

  it("shows a ring on the button while the message goes out, and says so to a second Enter", async () => {
    let finish!: (result: { accepted: true }) => void;
    const onSubmit = vi.fn(() => new Promise<{ accepted: true }>((resolve) => { finish = resolve; }));
    const onNotify = vi.fn();
    renderComposer({ onSubmit, onNotify });

    expect(iconOf(sendButton())).toBe("lucide-arrow-up");
    fireEvent.change(field(), { target: { value: "first", selectionStart: 5 } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(sendButton().getAttribute("aria-busy")).toBe("true"));

    expect(sendButton().querySelector(".spinner")).toBeTruthy();
    expect(sendButton().querySelector("svg")).toBeNull();
    expect(sendButton().dataset.tooltip).toBe("Still sending the previous message.");
    fireEvent.change(field(), { target: { value: "second", selectionStart: 6 } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onNotify).toHaveBeenCalledWith("Still sending the previous message.");
    expect(onSubmit).toHaveBeenCalledTimes(1);

    await act(async () => finish({ accepted: true }));
    await waitFor(() => expect(sendButton().querySelector(".spinner")).toBeNull());
    expect(iconOf(sendButton())).toBe("lucide-arrow-up");
  });
});

describe("the send button while a turn runs", () => {
  it("draws a queue for a follow-up and a turn for a steer, and the tooltip says the same", () => {
    renderComposer({ streaming: true });
    expect(iconOf(sendButton())).toBe("lucide-corner-up-right");
    expect(sendButton().dataset.tooltip).toMatch(/^Steer this turn/u);
    cleanup();

    const registry = new ExtensionRegistry();
    registry.activate({ id: "queueing", name: "Queueing", activate(context) { context.registerPromptHook({ id: "queueing.hook", streamingDelivery: () => "followUp" }); } });
    renderComposer({ streaming: true, registry });
    expect(iconOf(sendButton())).toBe("lucide-list-plus");
    expect(sendButton().dataset.tooltip).toMatch(/^Queue after this turn/u);
  });
});

describe("the queued count", () => {
  const queue: UiQueuedMessage[] = [{ id: "q1", text: "later", attachments: 0 }, { id: "q2", text: "and later", attachments: 0 }];

  it("opens the queue when the composer can show it", () => {
    const onOpenQueue = vi.fn();
    renderComposer({ streaming: true, queue, onOpenQueue });
    fireEvent.click(screen.getByRole("button", { name: "2 queued" }));
    expect(onOpenQueue).toHaveBeenCalledOnce();
  });

  it("stays a plain count where nothing can show the queue", () => {
    renderComposer({ streaming: true, queue });
    expect(screen.queryByRole("button", { name: "2 queued" })).toBeNull();
    expect(screen.getByText("2 queued").tagName).toBe("SPAN");
  });
});
