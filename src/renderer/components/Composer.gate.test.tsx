// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, UiModel } from "../../shared/contracts";
import { Composer } from "./Composer";
import { ComposerScopeStore } from "../../workbench/composer-scope-store";
import { ExtensionRegistry, type ComposerGateContext, type ComposerGateContribution, type ComposerGateProps, type ModelBadgeContribution } from "../extension-system";
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

function renderComposer(model: UiModel, gates: ComposerGateContribution[], badges: ModelBadgeContribution[] = [], onRunShellAction?: (command: string) => Promise<unknown>) {
  const registry = new ExtensionRegistry();
  registry.activate({
    id: "test.policy",
    name: "Test Policy",
    activate(context) {
      for (const gate of gates) context.registerComposerGate(gate);
      for (const badge of badges) context.registerModelBadge(badge);
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
        onReorderQueue={() => {}}
        onSetModel={onSetModel}
        onSetThinking={() => {}}
        onCompactContext={() => {}}
        onRunShellAction={onRunShellAction}
      />
    </WorkbenchShellContext.Provider>
  </TestProviders>);
  return { onSubmit, onSetModel };
}

function send(text = "hello") {
  fireEvent.change(screen.getByPlaceholderText(/Direct the agent/u), { target: { value: text } });
  fireEvent.click(screen.getByLabelText("Send"));
}

function pick(name: string) {
  fireEvent.click(screen.getByLabelText(/^Select model:/u));
  const input = screen.getByRole("textbox", { name: "Search models" });
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

  it("hold a model choice, and reopen the picker when it is cancelled", () => {
    const { onSetModel } = renderComposer(plain, [asksFor("acme")]);
    pick("Acme");
    expect(onSetModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("No"));
    expect(screen.getByRole("dialog", { name: "Select model" })).toBeTruthy();
    pick("Acme");
    fireEvent.click(screen.getByText("Yes"));
    expect(onSetModel).toHaveBeenCalledWith("acme", "big");
  });
});

describe("model badges", () => {
  it("mark the models they apply to and explain themselves once under the list", () => {
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
    fireEvent.click(screen.getByRole("button", { name: /^acme/u }));
    const badge = screen.getByText("risky");
    expect(badge.getAttribute("title")).toBe("Acme says no");
    expect(badge.classList).toContain("model-badge-warning");
    expect(screen.getAllByText("Acme models are risky.")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /^OpenAI/u }));
    expect(screen.queryByText("risky")).toBeNull();
    expect(screen.queryByText("Acme models are risky.")).toBeNull();
  });
});
