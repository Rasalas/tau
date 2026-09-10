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

function renderComposer(runtimeChoice?: ComposerRuntimeChoice) {
  render(<TestProviders>
    <Composer
      scopeStore={new ComposerScopeStore()}
      snapshot={snapshot}
      queue={[]}
      contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
      textareaRef={createRef<HTMLTextAreaElement>()}
      onSubmit={vi.fn(async () => ({ accepted: true as const }))}
      onAbort={() => {}}
      onCancelQueued={() => {}}
      onSteerQueued={() => {}}
      onReorderQueue={() => {}}
      onSetModel={() => {}}
      onSetThinking={() => {}}
      onCompactContext={() => {}}
      runtimeChoice={runtimeChoice}
    />
  </TestProviders>);
}

afterEach(cleanup);

describe("composer runtime chip", () => {
  it("is absent for a thread that already exists", () => {
    renderComposer();
    expect(screen.queryByLabelText(/^Runtime:/u)).toBeNull();
  });

  it("carries a runtime's own mark on the chip when it has one", () => {
    renderComposer({ kind: "claude-code", backends: [{ kind: "pi", label: "Pi" }, { kind: "claude-code", label: "Claude Code" }], onSelect: () => {} });
    const chip = screen.getByLabelText("Runtime: Claude Code");
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
        onReorderQueue={() => {}}
        onSetModel={() => {}}
        onSetThinking={() => {}}
        onCompactContext={() => {}}
        runtimeChoice={{ kind: "acme", backends: [{ kind: "pi", label: "Pi" }, { kind: "acme", label: "Acme Agent" }], onSelect: () => {} }}
      />
    </TestProviders>);
    const chip = screen.getByLabelText("Model selection unavailable");
    expect(chip.textContent).toBe("default model");
    expect(chip.getAttribute("title")).toMatch(/starts on Acme Agent's own model/u);
    expect(screen.queryByText("Claude Opus 5")).toBeNull();
    // The visible thread's reasoning level is not this draft's either.
    expect(screen.getByLabelText("Reasoning controls unavailable").textContent).toBe("—");
  });

  it("names the runtime of the next thread and offers the others", () => {
    const onSelect = vi.fn();
    renderComposer({ kind: "acme", backends: [{ kind: "pi", label: "Pi" }, { kind: "acme", label: "Acme Agent" }], onSelect });
    // A runtime with a mark of its own carries it; one without shows its name alone, never a letter box.
    expect(screen.getByLabelText("Runtime: Acme Agent").querySelector(".provider-icon-stack")).toBeNull();
    fireEvent.click(screen.getByLabelText("Runtime: Acme Agent"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Pi/u }));
    expect(onSelect).toHaveBeenCalledWith("pi");
  });
});
