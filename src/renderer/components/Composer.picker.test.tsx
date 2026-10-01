// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, UiModel, UiRuntimeCatalog } from "../../shared/contracts";
import { Composer } from "./Composer";
import { ComposerScopeStore } from "../../workbench/composer-scope-store";
import { TestProviders } from "../test-support/test-providers";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import type { ComposerRuntimeChoice } from "./Composer";

const luna: UiModel = { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" };
const sol: UiModel = { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" };

const snapshot: HostSnapshot = {
  cwd: "/project", sessionId: "session", sessionTitle: "Thread", backendKind: "pi",
  model: luna, models: [luna, sol],
  runtimeBackends: [{ kind: "pi", label: "Pi" }, { kind: "codex", label: "Codex" }],
  thinkingLevel: "medium", thinkingLevels: ["medium"],
  messages: [], isStreaming: false, activeTools: [], allTools: [], extensionCount: 0,
};

function renderComposer(options: { runtimeChoice?: ComposerRuntimeChoice; onNewThreadOnRuntime?: (kind: string, model?: UiModel, via?: (kind: string) => void) => void; snapshot?: HostSnapshot } = {}) {
  const onSetModel = vi.fn();
  const onSetThinking = vi.fn();
  const textareaRef = createRef<HTMLTextAreaElement>();
  // The host's cache holds Codex's catalog; no Codex thread has ever run.
  const client = createFakeHostClient({
    runtimeCatalogs: async (): Promise<UiRuntimeCatalog[]> => [
      { kind: "codex", models: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", billing: "subscription" }, { provider: "openai", id: "gpt-5.5", name: "GPT-5.5", billing: "subscription" }], thinkingLevels: {}, checkedAt: 1 },
      { kind: "pi", models: [luna, sol], thinkingLevels: { "openai-codex/gpt-5.6-sol": ["low", "medium"] }, checkedAt: 1 },
    ],
  });
  render(<TestProviders><HostClientProvider client={client}>
    <Composer
      runtimeChoice={options.runtimeChoice}
      onNewThreadOnRuntime={options.onNewThreadOnRuntime}
      scopeStore={new ComposerScopeStore()}
      snapshot={options.snapshot ?? snapshot}
      queue={[]}
      contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
      textareaRef={textareaRef}
      onSubmit={vi.fn(async () => ({ accepted: true as const }))}
      onAbort={() => {}}
      onCancelQueued={() => {}}
      onSteerQueued={() => {}}
      onSetModel={onSetModel}
      onSetThinking={onSetThinking}
      onCompactContext={() => {}}
    />
  </HostClientProvider></TestProviders>);
  const chip = screen.getByLabelText(/^Select (runtime and )?model:/u);
  return { onSetModel, onSetThinking, chip, textareaRef };
}

async function openPicker(chip: HTMLElement) {
  chip.focus();
  fireEvent.click(chip);
  const picker = await screen.findByRole("dialog", { name: "Select model" });
  const input = screen.getByRole("combobox", { name: "Search models" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  return { picker, input };
}

afterEach(cleanup);

describe("model picker at the model chip", () => {
  it("opens as a popover without a scrim, beside its chip", async () => {
    const { chip } = renderComposer();
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    const { picker } = await openPicker(chip);
    expect(picker.classList).toContain("popover");
    expect(picker.getAttribute("aria-modal")).toBeNull();
    expect(document.querySelector(".palette-backdrop")).toBeNull();
    expect(chip.getAttribute("aria-expanded")).toBe("true");
  });

  it("walks the list with the arrows, takes a model with Enter and hands focus to the prompt", async () => {
    const { chip, onSetModel, textareaRef } = renderComposer();
    const { input } = await openPicker(chip);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSetModel).toHaveBeenCalledWith("openai-codex", "gpt-5.6-sol");
    expect(screen.queryByRole("dialog", { name: "Select model" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(textareaRef.current));
  });

  it("carries the level to the next model, or the next lower one it has, and says so with Undo (K142)", async () => {
    const { chip, onSetModel, onSetThinking } = renderComposer({ snapshot: { ...snapshot, thinkingLevel: "high", thinkingLevels: ["low", "medium", "high"] } });
    await openPicker(chip);
    await screen.findByRole("radio", { name: "Codex, Plan" });
    fireEvent.click(screen.getByRole("option", { name: /^GPT-5.6 Sol, Pi/u }));
    expect(onSetModel).toHaveBeenCalledWith("openai-codex", "gpt-5.6-sol");
    expect(onSetThinking).toHaveBeenCalledWith("medium");
    const notice = screen.getByRole("status");
    expect(notice.textContent).toBe("Thinking is Medium now: GPT-5.6 Sol has no High.Undo");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onSetModel).toHaveBeenLastCalledWith("openai-codex", "gpt-5.6-luna");
    expect(onSetThinking).toHaveBeenLastCalledWith("high");
    expect(screen.queryByText(/Thinking is Medium now/u)).toBeNull();
  });

  it("gives focus back to its chip on Escape", async () => {
    const { chip, onSetModel } = renderComposer();
    await openPicker(chip);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Select model" })).toBeNull();
    expect(document.activeElement).toBe(chip);
    expect(onSetModel).not.toHaveBeenCalled();
  });

  it("closes on a second press of its chip and on a press outside", async () => {
    const { chip } = renderComposer();
    await openPicker(chip);
    fireEvent.pointerDown(chip);
    fireEvent.click(chip);
    expect(screen.queryByRole("dialog", { name: "Select model" })).toBeNull();
    await openPicker(chip);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Select model" })).toBeNull();
  });

  it("binds a draft to another runtime's model from the host's cache", async () => {
    const onSelect = vi.fn();
    const { chip, onSetModel } = renderComposer({ runtimeChoice: { kind: "pi", backends: snapshot.runtimeBackends!, onSelect } });
    await openPicker(chip);
    fireEvent.click(await screen.findByRole("radio", { name: "Codex, Plan" }));
    expect(onSelect).toHaveBeenCalledWith("codex");
    expect(onSetModel).toHaveBeenCalledWith("openai", "gpt-5.6-luna");
  });

  it("offers a thread that exists a new thread for a model only another runtime runs", async () => {
    const onNewThreadOnRuntime = vi.fn();
    const { chip, onSetModel } = renderComposer({ onNewThreadOnRuntime });
    const { input } = await openPicker(chip);
    fireEvent.change(input, { target: { value: "5.5" } });
    expect(await screen.findByRole("button", { name: "Pi, can't run it" })).toHaveProperty("disabled", true);
    expect(document.querySelector(".model-ways-note")?.textContent).toBe("This thread runs with Pi. ↵ starts a new thread with Codex.");
    fireEvent.click(screen.getByRole("radio", { name: "Codex, Plan" }));
    // The new thread starts on the model chosen for it.
    expect(onNewThreadOnRuntime).toHaveBeenCalledWith("codex", expect.objectContaining({ provider: "openai", id: "gpt-5.5" }), undefined);
    expect(onSetModel).not.toHaveBeenCalled();
  });

  it("keeps Tab inside the popover", async () => {
    const { chip } = renderComposer();
    const { picker, input } = await openPicker(chip);
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(picker.contains(document.activeElement)).toBe(true);
  });
});
