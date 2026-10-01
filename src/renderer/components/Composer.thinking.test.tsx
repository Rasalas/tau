// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, UiModel } from "../../shared/contracts";
import type { ComposerSpeedState } from "../extension-system";
import { ComposerScopeStore } from "../../workbench/composer-scope-store";
import { createKitHarness } from "../test-support/kit-harness";
import { TestProviders } from "../test-support/test-providers";
import { WorkbenchShellContext } from "../workbench-context";
import { Composer } from "./Composer";

const opus: UiModel = { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", contextWindow: 200_000 };
const opus1m: UiModel = { provider: "anthropic", id: "claude-opus-5-5[1m]", name: "Claude Opus 5.5 (1M)" };
const sol: UiModel = { provider: "openai", id: "gpt-6-sol", name: "GPT-6 Sol" };

const base: HostSnapshot = {
  cwd: "/project", sessionId: "session", sessionTitle: "Thread", backendKind: "pi",
  models: [opus, opus1m, sol], model: opus, thinkingLevel: "high", thinkingLevels: ["low", "medium", "high"],
  runtimeBackends: [{ kind: "pi", label: "Pi" }],
  messages: [], isStreaming: false, activeTools: [], allTools: [], extensionCount: 0,
};

afterEach(cleanup);

/** A kit's Fast that the test switches by hand. */
function speedKit() {
  let state: ComposerSpeedState | undefined = { fast: true, available: true, detail: "Priority routing" };
  const listeners = new Set<() => void>();
  const set = vi.fn((fast: boolean) => { state = { ...state!, fast }; listeners.forEach((listener) => listener()); });
  return {
    contribution: { id: "test.speed", read: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, set },
    change(next: ComposerSpeedState | undefined) { state = next; listeners.forEach((listener) => listener()); },
    set,
  };
}

function renderComposer(snapshot: HostSnapshot, speed?: ReturnType<typeof speedKit>) {
  const { registry } = createKitHarness();
  if (speed) registry.activate({ id: "test.speed", name: "Speed", activate(context) { context.registerComposerSpeed(speed.contribution); } });
  const onSetModel = vi.fn();
  const onSetThinking = vi.fn();
  const view = render(<TestProviders><WorkbenchShellContext.Provider value={{ registry }}>
    <Composer
      scopeStore={new ComposerScopeStore()} snapshot={snapshot} queue={[]} contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
      textareaRef={createRef<HTMLTextAreaElement>()} onSubmit={vi.fn(async () => ({ accepted: true as const }))}
      onAbort={() => {}} onCancelQueued={() => {}} onSteerQueued={() => {}} onSetModel={onSetModel} onSetThinking={onSetThinking} onCompactContext={() => {}}
    />
  </WorkbenchShellContext.Provider></TestProviders>);
  const rerender = (next: HostSnapshot) => view.rerender(<TestProviders><WorkbenchShellContext.Provider value={{ registry }}>
    <Composer
      scopeStore={new ComposerScopeStore()} snapshot={next} queue={[]} contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
      textareaRef={createRef<HTMLTextAreaElement>()} onSubmit={vi.fn(async () => ({ accepted: true as const }))}
      onAbort={() => {}} onCancelQueued={() => {}} onSteerQueued={() => {}} onSetModel={onSetModel} onSetThinking={onSetThinking} onCompactContext={() => {}}
    />
  </WorkbenchShellContext.Provider></TestProviders>);
  return { onSetModel, onSetThinking, rerender };
}

const openMenu = async (label: RegExp) => {
  fireEvent.click(screen.getByLabelText(label));
  return screen.findByRole("dialog", { name: "Thinking, context window and speed" });
};

describe("the thinking chip (K142)", () => {
  it("reads 'High · 200k ⚡' and offers the level, the context window and Fast in one menu", async () => {
    const speed = speedKit();
    const { onSetModel, onSetThinking } = renderComposer(base, speed);
    const chip = screen.getByLabelText("Thinking: High · 200k, Fast");
    expect(chip.textContent).toBe("High · 200k");
    expect(chip.querySelector(".composer-fast")).toBeTruthy();
    let menu = await openMenu(/^Thinking: High/u);
    expect(within(within(menu).getByRole("group", { name: "Context window" })).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["200kDefault", "1M"]);
    fireEvent.click(within(menu).getByRole("radio", { name: /^Low/u }));
    expect(onSetThinking).toHaveBeenCalledWith("low");
    expect(screen.queryByRole("dialog", { name: "Thinking, context window and speed" })).toBeNull();
    menu = await openMenu(/^Thinking: High/u);
    fireEvent.click(within(menu).getByRole("radio", { name: /^1M/u }));
    expect(onSetModel).toHaveBeenCalledWith("anthropic", "claude-opus-5-5[1m]");
    menu = await openMenu(/^Thinking: High/u);
    fireEvent.click(within(menu).getByRole("radio", { name: /^Standard/u }));
    expect(speed.set).toHaveBeenCalledWith(false, expect.objectContaining({ sessionId: "session" }));
    expect(screen.getByLabelText("Thinking: High · 200k").querySelector(".composer-fast")).toBeNull();
  });

  it("greys Fast with the reason where no kit offers it, and leaves out a context window there is no choice of", async () => {
    renderComposer({ ...base, model: sol });
    const menu = await openMenu(/^Thinking: High$/u);
    expect(within(menu).queryByRole("group", { name: "Context window" })).toBeNull();
    const fast = within(menu).getByRole("radio", { name: /^Fast/u });
    expect(fast).toHaveProperty("disabled", true);
    expect(fast.textContent).toBe("FastPi offers no Fast tier.");
  });

  it("says Fast went away with a model that has none, with Undo (from D)", async () => {
    const speed = speedKit();
    const { onSetModel, rerender } = renderComposer(base, speed);
    const menu = await openMenu(/^Thinking: High/u);
    fireEvent.click(within(menu).getByRole("radio", { name: /^1M/u }));
    expect(onSetModel).toHaveBeenLastCalledWith("anthropic", "claude-opus-5-5[1m]");
    rerender({ ...base, model: opus1m });
    act(() => speed.change({ fast: true, available: false, reason: "No Fast for this model" }));
    const notice = await screen.findByText(/Fast is off: No Fast for this model\./u);
    fireEvent.click(within(notice.closest(".composer-adjusted") as HTMLElement).getByRole("button", { name: "Undo" }));
    expect(onSetModel).toHaveBeenLastCalledWith("anthropic", "claude-opus-5-5");
  });
});
