// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "../../shared/contracts";
import { Composer } from "./Composer";
import { ComposerScopeStore } from "../../workbench/composer-scope-store";
import { ExtensionRegistry, type ComposerSendMode, type WorkbenchActions } from "../extension-system";
import { WorkbenchShellContext } from "../workbench-context";
import { TestProviders } from "../test-support/test-providers";

const base: HostSnapshot = {
  cwd: "/project", sessionId: "session", sessionTitle: "Thread", backendKind: "pi",
  models: [], thinkingLevel: "medium", thinkingLevels: ["medium"],
  messages: [], isStreaming: false, activeTools: [], allTools: [], extensionCount: 0,
};

function setup(options: { snapshot?: HostSnapshot; newThread?: boolean; beforeSend?: (actions: WorkbenchActions | undefined) => Promise<void> } = {}) {
  let finish: () => void = () => undefined;
  const beforeSend = vi.fn(options.beforeSend ?? (() => new Promise<void>((resolve) => { finish = resolve; })));
  const always = vi.fn();
  const mode: ComposerSendMode = {
    label: "Compact and send",
    busyLabel: "Compacting…",
    title: "Summarize 153k tokens of earlier history, then send",
    beforeSend,
    options: [
      { id: "full", label: "Send with full history", send: true },
      { id: "never", label: "Never offer", run: always },
    ],
  };
  const registry = new ExtensionRegistry();
  registry.activate({
    id: "test.send-mode",
    name: "Send Mode",
    activate(context) {
      context.registerComposerSendMode({ id: "test.compact", profiles: ["desktop"], read: () => mode, subscribe: () => () => undefined });
    },
  });
  const onSubmit = vi.fn(async () => ({ accepted: true as const }));
  const onNotify = vi.fn();
  const actions = { compactContext: vi.fn() } as unknown as WorkbenchActions;
  const snapshot = options.snapshot ?? base;
  render(<TestProviders>
    <WorkbenchShellContext.Provider value={{ registry, snapshot, actions }}>
      <Composer
        scopeStore={new ComposerScopeStore()}
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
        onNotify={onNotify}
        newThread={options.newThread ?? false}
      />
    </WorkbenchShellContext.Provider>
  </TestProviders>);
  const type = (text: string) => fireEvent.change(screen.getByPlaceholderText(/Ask anything/u), { target: { value: text } });
  return { beforeSend, onSubmit, onNotify, always, actions, type, finish: () => finish() };
}

afterEach(cleanup);

describe("a kit's send mode", () => {
  it("words the send button and runs before the prompt, which waits for it", async () => {
    const { beforeSend, onSubmit, actions, type, finish } = setup();
    type("hello");
    fireEvent.keyDown(screen.getByPlaceholderText(/Ask anything/u), { key: "Enter" });
    expect(beforeSend).toHaveBeenCalledWith(actions);
    const busy = screen.getByRole("button", { name: "Compacting…" }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect((onSubmit.mock.calls as unknown[][])[0]?.[0]).toBe("hello");
    expect(screen.getByRole("button", { name: "Compact and send" })).toBeTruthy();
  });

  it("sends as usual from the menu beside it, and runs an entry that sends nothing", async () => {
    const { beforeSend, onSubmit, always, type } = setup();
    type("hello");
    fireEvent.click(screen.getByRole("button", { name: "Send options" }));
    fireEvent.click(await screen.findByRole("button", { name: "Never offer" }));
    expect(always).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Send options" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send with full history" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(beforeSend).not.toHaveBeenCalled();
  });

  it("keeps the draft and says why when it fails", async () => {
    const { onSubmit, onNotify, type } = setup({ beforeSend: async () => { throw new Error("Compaction is unavailable here."); } });
    type("hello");
    fireEvent.click(screen.getByRole("button", { name: "Compact and send" }));
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith("Compaction is unavailable here."));
    expect(onSubmit).not.toHaveBeenCalled();
    expect((screen.getByPlaceholderText(/Ask anything/u) as HTMLTextAreaElement).value).toBe("hello");
  });

  it("leaves a streaming thread and a new thread's draft the plain send button", () => {
    setup({ snapshot: { ...base, isStreaming: true } });
    expect(screen.queryByRole("button", { name: "Compact and send" })).toBeNull();
    cleanup();
    setup({ newThread: true });
    expect(screen.queryByRole("button", { name: "Compact and send" })).toBeNull();
    expect(screen.getByLabelText("Send")).toBeTruthy();
  });
});
