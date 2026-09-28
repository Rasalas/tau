// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "../../shared/contracts";
import { Composer, type ComposerRuntimeChoice } from "./Composer";
import { ComposerScopeStore } from "../../workbench/composer-scope-store";
import { TestProviders } from "../test-support/test-providers";

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
};

function renderComposer(runtimeChoice?: ComposerRuntimeChoice, visible: HostSnapshot = snapshot, onSetModel = vi.fn(), onNewThreadOnRuntime?: (kind: string) => void) {
  render(<TestProviders>
    <Composer
      scopeStore={new ComposerScopeStore()}
      snapshot={visible}
      queue={[]}
      contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
      textareaRef={createRef<HTMLTextAreaElement>()}
      onSubmit={vi.fn(async () => ({ accepted: true as const }))}
      onAbort={() => {}}
      onCancelQueued={() => {}}
      onSteerQueued={() => {}}
      onSetModel={onSetModel}
      onSetThinking={() => {}}
      onCompactContext={() => {}}
      runtimeChoice={runtimeChoice}
      onNewThreadOnRuntime={onNewThreadOnRuntime}
    />
  </TestProviders>);
  return onSetModel;
}

const piThread: HostSnapshot = {
  ...snapshot,
  backendKind: "pi",
  runtimeBackends: [{ kind: "pi", label: "Pi" }, { kind: "claude-code", label: "Claude Code" }],
  model: { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
  models: [{ provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
};

afterEach(cleanup);

describe("composer runtime choice", () => {
  it("shows a Pi thread's plan beside Pi's mark, and offers other runtimes as new threads", async () => {
    const onNewThreadOnRuntime = vi.fn();
    renderComposer(undefined, piThread, vi.fn(), onNewThreadOnRuntime);
    const chip = screen.getByLabelText("Select model: GPT-5.6 Luna");
    expect(chip.querySelector(".provider-family-codex")).toBeTruthy();
    expect(chip.querySelector(".provider-family-pi")).toBeTruthy();
    fireEvent.click(chip);
    fireEvent.click(await screen.findByRole("button", { name: /^Claude Code,/u }));
    fireEvent.click(screen.getByRole("button", { name: "New thread on Claude Code" }));
    expect(onNewThreadOnRuntime).toHaveBeenCalledWith("claude-code");
  });

  it("brings a draft bound elsewhere back to Pi when one of Pi's models is picked", async () => {
    const onSelect = vi.fn();
    const onSetModel = renderComposer({ kind: "claude-code", backends: piThread.runtimeBackends ?? [], onSelect }, piThread);
    fireEvent.click(screen.getByLabelText("Select runtime and model: Claude Code"));
    fireEvent.click(await screen.findByRole("button", { name: "Pi, ready" }));
    fireEvent.click(screen.getByText("GPT-5.6 Luna"));
    expect(onSelect).toHaveBeenCalledWith("pi");
    expect(onSetModel).toHaveBeenCalledWith("openai-codex", "gpt-5.6-luna");
  });

  it("carries the selected runtime's mark on the model chip", () => {
    renderComposer({ kind: "claude-code", backends: [{ kind: "pi", label: "Pi" }, { kind: "claude-code", label: "Claude Code" }], onSelect: () => {} });
    const chip = screen.getByLabelText("Select runtime and model: Claude Code");
    expect(chip.querySelector(".provider-icon-stack .provider-mark")).toBeTruthy();
  });

  it("offers no model of the visible thread to a draft bound for another runtime", () => {
    const withModel = { ...snapshot, backendKind: "pi", model: { provider: "anthropic", id: "m", name: "Claude Opus 5" }, models: [{ provider: "anthropic", id: "m", name: "Claude Opus 5" }] };
    render(<TestProviders>
      <Composer
        scopeStore={new ComposerScopeStore()}
        snapshot={withModel}
        queue={[]}
        contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
        textareaRef={createRef<HTMLTextAreaElement>()}
        onSubmit={vi.fn(async () => ({ accepted: true as const }))}
        onAbort={() => {}}
        onCancelQueued={() => {}}
        onSteerQueued={() => {}}
        onSetModel={() => {}}
        onSetThinking={() => {}}
        onCompactContext={() => {}}
        runtimeChoice={{ kind: "acme", backends: [{ kind: "pi", label: "Pi" }, { kind: "acme", label: "Acme Agent" }], onSelect: () => {} }}
      />
    </TestProviders>);
    const chip = screen.getByLabelText("Select runtime and model: Acme Agent");
    expect(chip.textContent).toContain("default model");
    expect(chip.getAttribute("data-tooltip")).toMatch(/start with Acme Agent's default model/u);
    expect(screen.queryByText("Claude Opus 5")).toBeNull();
    // The visible thread's reasoning level is not this draft's either.
    expect(screen.getByLabelText("Reasoning controls unavailable").textContent).toBe("—");
  });

  it("offers runtime choices inside the model picker", async () => {
    const onSelect = vi.fn();
    renderComposer({ kind: "acme", backends: [{ kind: "pi", label: "Pi" }, { kind: "acme", label: "Acme Agent" }], onSelect });
    expect(screen.queryByLabelText(/^Runtime:/u)).toBeNull();
    fireEvent.click(screen.getByLabelText("Select runtime and model: Acme Agent"));
    fireEvent.click(await screen.findByRole("button", { name: /^Pi,/u }));
    fireEvent.click(screen.getByRole("button", { name: "Start this thread on Pi" }));
    expect(onSelect).toHaveBeenCalledWith("pi");
  });
});
