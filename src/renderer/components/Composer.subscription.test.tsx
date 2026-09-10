// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, UiModel } from "../../shared/contracts";
import { Composer } from "./Composer";
import { ComposerScopeStore } from "../../workbench/composer-scope-store";
import { TestProviders } from "../test-support/test-providers";
import { PreferencesStore } from "../preferences";

const subscribed: UiModel = { provider: "anthropic", id: "opus", name: "Opus", login: "subscription" };
const codexSubscription: UiModel = { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", login: "subscription" };
const keyed: UiModel = { provider: "opencode-go", id: "kimi", name: "Kimi" };

function snapshotWith(model: UiModel, backendKind = model === subscribed ? "claude-code" : "pi"): HostSnapshot {
  return {
    cwd: "/project", sessionId: "session", sessionTitle: "Thread",
    backendKind,
    model, models: [subscribed, codexSubscription, keyed],
    thinkingLevel: "medium", thinkingLevels: ["medium"],
    messages: [], isStreaming: false, activeTools: [], allTools: [], extensionCount: 0,
  };
}

function renderComposer(model: UiModel, preferences = new PreferencesStore(), backendKind?: string) {
  const onSubmit = vi.fn(async () => ({ accepted: true as const }));
  const onSetModel = vi.fn();
  const scopeStore = new ComposerScopeStore();
  render(<TestProviders preferences={preferences}>
    <Composer
      scopeStore={scopeStore}
      snapshot={snapshotWith(model, backendKind)}
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
    />
  </TestProviders>);
  return { onSubmit, onSetModel, preferences };
}

afterEach(cleanup);

describe("subscription login warning in the composer", () => {
  it("asks once before the first prompt on such a model, then sends", async () => {
    const { onSubmit, preferences } = renderComposer(subscribed);
    fireEvent.change(screen.getByPlaceholderText(/Direct the agent/u), { target: { value: "hello" } });
    fireEvent.click(screen.getByLabelText("Send"));
    expect(onSubmit).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Subscription login through Pi" });
    expect(dialog.textContent).toMatch(/without notice/u);

    fireEvent.click(screen.getByText("Use it anyway"));
    await Promise.resolve();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(preferences.hasAcknowledgedSubscriptionLogin("anthropic")).toBe(true);
    expect(screen.queryByRole("dialog", { name: "Subscription login through Pi" })).toBeNull();
  });

  it("does not warn for an OpenAI Codex subscription", () => {
    const { onSubmit } = renderComposer(codexSubscription);
    fireEvent.change(screen.getByPlaceholderText(/Direct the agent/u), { target: { value: "hello" } });
    fireEvent.click(screen.getByLabelText("Send"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Subscription login through Pi" })).toBeNull();
  });

  it("asks nothing for an API-key model or once the provider was acknowledged", () => {
    const preferences = new PreferencesStore();
    preferences.acknowledgeSubscriptionLogin("anthropic");
    const { onSubmit } = renderComposer(subscribed, preferences);
    fireEvent.change(screen.getByPlaceholderText(/Direct the agent/u), { target: { value: "hello" } });
    fireEvent.click(screen.getByLabelText("Send"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    cleanup();
    const keyedRender = renderComposer(keyed);
    fireEvent.change(screen.getByPlaceholderText(/Direct the agent/u), { target: { value: "hello" } });
    fireEvent.click(screen.getByLabelText("Send"));
    expect(keyedRender.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("asks when such a model is picked, and declining reopens the picker", () => {
    const { onSetModel } = renderComposer(keyed, new PreferencesStore(), "claude-code");
    const pickOpus = () => {
      const input = screen.getByRole("textbox", { name: "Search models" });
      fireEvent.change(input, { target: { value: "Opus" } });
      fireEvent.keyDown(input, { key: "Enter" });
    };
    fireEvent.click(screen.getByLabelText(/^Select model/u));
    pickOpus();
    expect(onSetModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Pick another model"));
    expect(screen.getByRole("dialog", { name: "Select model" })).toBeTruthy();
    pickOpus();
    fireEvent.click(screen.getByText("Use it anyway"));
    expect(onSetModel).toHaveBeenCalledWith("anthropic", "opus");
  });
});
