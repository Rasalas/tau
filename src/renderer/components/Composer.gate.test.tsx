// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, UiModel } from "../../shared/contracts";
import { Composer } from "./Composer";
import { ComposerScopeStore } from "../../workbench/composer-scope-store";
import { ExtensionRegistry, type ComposerGateContext, type ComposerGateContribution, type ComposerGateProps, type ModelBadgeContribution, type ModelSelectionContribution } from "../extension-system";
import { WorkbenchShellContext } from "../workbench-context";
import { TestProviders } from "../test-support/test-providers";

const guarded: UiModel = { provider: "acme", id: "big", name: "Acme Big" };
const plain: UiModel = { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" };

function snapshotWith(model: UiModel): HostSnapshot {
  return {
    cwd: "/project", sessionId: "session", sessionTitle: "Thread", backendKind: "pi",
    model, models: [guarded, plain],
    thinkingLevel: "medium", thinkingLevels: ["medium"],
    messages: [], isStreaming: false, activeTools: [], allTools: [], extensionCount: 0,
  };
}

function Ask({ context, proceed, cancel }: ComposerGateProps) {
  return (
    <section role="dialog" aria-label={`Ask ${context.action}`}>
      <button onClick={cancel}>No</button>
      <button onClick={proceed}>Yes</button>
    </section>
  );
}

function renderComposer(model: UiModel, gates: ComposerGateContribution[], badges: ModelBadgeContribution[] = [], onRunShellAction?: (command: string) => Promise<unknown>, modelSet?: ModelSelectionContribution) {
  const registry = new ExtensionRegistry();
  registry.activate({
    id: "test.policy",
    name: "Test Policy",
    activate(context) {
      for (const gate of gates) context.registerComposerGate(gate);
      for (const badge of badges) context.registerModelBadge(badge);
      if (modelSet) context.registerModelSelection(modelSet);
    },
  });
  const onSubmit = vi.fn(async () => ({ accepted: true as const }));
  const onSetModel = vi.fn();
  const snapshot = snapshotWith(model);
  render(<TestProviders>
    <WorkbenchShellContext.Provider value={{ registry, snapshot }}>
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
        onSetModel={onSetModel}
        onSetThinking={() => {}}
        onCompactContext={() => {}}
        onRunShellAction={onRunShellAction}
        newThread={modelSet !== undefined}
      />
    </WorkbenchShellContext.Provider>
  </TestProviders>);
  return { onSubmit, onSetModel };
}

function send(text = "hello") {
  fireEvent.change(screen.getByPlaceholderText(/Ask anything/u), { target: { value: text } });
  fireEvent.click(screen.getByLabelText("Send"));
}

async function pick(name: string) {
  // The chip toggles the picker; a picker already open is used as it is.
  if (!screen.queryByRole("dialog", { name: "Select model" })) fireEvent.click(screen.getByLabelText(/^Select model:/u));
  const input = await screen.findByRole("combobox", { name: "Search models" });
  fireEvent.change(input, { target: { value: name } });
  fireEvent.keyDown(input, { key: "Enter" });
}

const asksFor = (provider: string, seen: ComposerGateContext[] = []): ComposerGateContribution => ({
  id: `test.ask-${provider}`,
  profiles: ["desktop"],
  check: (context) => { seen.push(context); return context.model?.provider === provider; },
  Component: Ask,
});

afterEach(cleanup);

describe("composer gates", () => {
  it("hold a prompt until the dialog proceeds, and say which model it goes to", async () => {
    const seen: ComposerGateContext[] = [];
    const { onSubmit } = renderComposer(guarded, [asksFor("acme", seen)]);
    send();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(seen.at(-1)).toMatchObject({ action: "prompt", model: guarded, runtime: "pi" });
    fireEvent.click(screen.getByText("Yes"));
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Ask prompt" })).toBeNull();
  });

  it("say when the prompt starts a new thread", () => {
    const seen: ComposerGateContext[] = [];
    renderComposer(plain, [asksFor("acme", seen)]);
    send();
    expect(seen.at(-1)?.newThread).toBeUndefined();
    cleanup();
    const modelSet: ModelSelectionContribution = { id: "test.set", selected: () => [], subscribe: () => () => undefined, toggle: () => undefined, reset: () => undefined };
    renderComposer(plain, [asksFor("acme", seen)], [], undefined, modelSet);
    send();
    expect(seen.at(-1)).toMatchObject({ action: "prompt", newThread: true });
  });

  it("drop a prompt the dialog cancels, and let other models through untouched", () => {
    const { onSubmit } = renderComposer(guarded, [asksFor("acme")]);
    send();
    fireEvent.click(screen.getByText("No"));
    expect(onSubmit).not.toHaveBeenCalled();
    cleanup();
    const other = renderComposer(plain, [asksFor("acme")]);
    send();
    expect(other.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("ask no gate for a shell command", () => {
    const shell = vi.fn(async () => undefined);
    const { onSubmit } = renderComposer(guarded, [asksFor("acme")], [], shell);
    send("!ls");
    expect(screen.queryByRole("dialog", { name: "Ask prompt" })).toBeNull();
    expect(shell).toHaveBeenCalledWith("ls", true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("hold the alternate send, the one that starts a thread in the background", async () => {
    const { onSubmit } = renderComposer(guarded, [asksFor("acme")]);
    const field = screen.getByPlaceholderText(/Ask anything/u);
    fireEvent.change(field, { target: { value: "in the background" } });
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Yes"));
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect((onSubmit.mock.calls[0] as unknown[])[2]).toBe("alternate");
  });

  it("hold a model added to a new thread's model set, and let one taken out go", async () => {
    let keys: string[] = [];
    const listeners = new Set<() => void>();
    const modelSet: ModelSelectionContribution = {
      id: "test.set",
      selected: () => keys,
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      toggle: (model) => {
        const key = `${model.provider}/${model.id}`;
        keys = keys.includes(key) ? keys.filter((entry) => entry !== key) : [...keys, key];
        for (const listener of listeners) listener();
      },
      reset: () => { keys = []; },
    };
    renderComposer(plain, [asksFor("acme")], [], undefined, modelSet);
    fireEvent.click(screen.getByLabelText(/^Select model:/u));
    fireEvent.click(await screen.findByRole("button", { name: /^acme/u }));
    const row = screen.getByText("Acme Big").closest("[role=option]")!;
    fireEvent.click(row, { shiftKey: true });
    expect(keys).toEqual([]);
    fireEvent.click(screen.getByText("Yes"));
    expect(keys).toEqual(["acme/big"]);
    fireEvent.click(screen.getByText("Acme Big").closest("[role=option]")!, { shiftKey: true });
    expect(keys).toEqual([]);
    expect(screen.queryByRole("dialog", { name: "Ask model" })).toBeNull();
  });

  it("run in order, each one asking in turn", async () => {
    const first = { ...asksFor("acme"), id: "test.first", order: 1, Component: ({ proceed }: ComposerGateProps) => <button onClick={proceed}>First</button> };
    const second = { ...asksFor("acme"), id: "test.second", order: 2, Component: ({ proceed }: ComposerGateProps) => <button onClick={proceed}>Second</button> };
    const { onSubmit } = renderComposer(guarded, [second, first]);
    send();
    fireEvent.click(screen.getByText("First"));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Second"));
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("hold a model choice, and reopen the picker when it is cancelled", async () => {
    const { onSetModel } = renderComposer(plain, [asksFor("acme")]);
    await pick("Acme");
    expect(onSetModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("No"));
    expect(await screen.findByRole("dialog", { name: "Select model" })).toBeTruthy();
    await pick("Acme");
    fireEvent.click(screen.getByText("Yes"));
    expect(onSetModel).toHaveBeenCalledWith("acme", "big");
  });
});

describe("model badges", () => {
  it("mark the models they apply to and explain themselves once under the list", async () => {
    renderComposer(plain, [], [{
      id: "test.badge",
      profiles: ["desktop"],
      applies: (model, runtime) => model.provider === "acme" && runtime === "pi",
      label: "risky",
      title: "Acme says no",
      tone: "warning",
      note: "Acme models are risky.",
    }]);
    fireEvent.click(screen.getByLabelText(/^Select model:/u));
    fireEvent.click(await screen.findByRole("button", { name: /^acme/u }));
    const badge = screen.getByText("risky");
    expect(badge.getAttribute("title")).toBe("Acme says no");
    expect(badge.classList).toContain("model-badge-warning");
    expect(screen.getAllByText("Acme models are risky.")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /^ChatGPT plan/u }));
    expect(screen.queryByText("risky")).toBeNull();
    expect(screen.queryByText("Acme models are risky.")).toBeNull();
  });
});
