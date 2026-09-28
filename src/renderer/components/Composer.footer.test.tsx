// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "../../shared/contracts";
import { ComposerScopeStore } from "../../workbench/composer-scope-store";
import { createKitHarness } from "../test-support/kit-harness";
import { TestProviders } from "../test-support/test-providers";
import { WorkbenchShellContext } from "../workbench-context";
import { Composer } from "./Composer";
import { ComposerMenuItem, ComposerMenuSection } from "./ComposerMenu";

const snapshot: HostSnapshot = {
  cwd: "/project",
  sessionId: "session",
  sessionTitle: "Thread",
  models: [{ provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
  model: { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
  thinkingLevel: "medium",
  thinkingLevels: ["off", "low", "medium", "high"],
  messages: [],
  isStreaming: false,
  activeTools: [],
  allTools: [],
  extensionCount: 0,
  supportsImageInput: true,
  usage: { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1_100, costUsd: 0.24, turns: 1 },
};

afterEach(cleanup);

function renderFooter(onSelectAccess = vi.fn()) {
  const { registry } = createKitHarness();
  registry.activate({
    id: "test.footer",
    name: "Footer",
    activate(context) {
      context.registerComposerControl({
        id: "test.access",
        placement: "menu",
        shortcuts: ["composer.mode"],
        Component: () => (
          <ComposerMenuSection heading="Access">
            <ComposerMenuItem label="Ask before edits" selected={false} onSelect={() => onSelectAccess("ask")} />
            <ComposerMenuItem label="Full access" selected onSelect={() => onSelectAccess("full")} />
          </ComposerMenuSection>
        ),
      });
      context.registerComposerControl({ id: "test.chip", Component: () => <button type="button" className="runtime-chip">Kit chip</button> });
    },
  });
  render(
    <TestProviders>
      <WorkbenchShellContext.Provider value={{ registry }}>
        <Composer
          scopeStore={new ComposerScopeStore()}
          snapshot={snapshot}
          queue={[]}
          contextUsage={{ tokens: 20_000, contextWindow: 100_000, percent: 20 }}
          contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
          textareaRef={createRef<HTMLTextAreaElement>()}
          onSubmit={vi.fn(async () => ({ accepted: true as const }))}
          onAbort={() => {}}
          onCancelQueued={() => {}}
          onSteerQueued={() => {}}
          onSetModel={() => {}}
          onSetThinking={() => {}}
          onCompactContext={() => {}}
        />
      </WorkbenchShellContext.Provider>
    </TestProviders>,
  );
  return { onSelectAccess };
}

describe("the composer's slim footer", () => {
  it("draws the model with its marks, the reasoning level as text, and a round send", () => {
    renderFooter();
    const model = screen.getByLabelText("Select model: GPT-5.6 Luna");
    expect(model.textContent).toContain("GPT-5.6 Luna");
    expect(model.querySelector(".provider-icon-stack, svg, img")).toBeTruthy();
    const reasoning = screen.getByLabelText("Reasoning: Medium");
    expect(reasoning.textContent).toBe("Medium");
    expect(reasoning.querySelector("svg")).toBeNull();
    expect(screen.getByRole("button", { name: "Send" }).classList.contains("send-button")).toBe(true);
    // The thread's cost is in its head now, not under the prompt.
    expect(screen.queryByLabelText(/^Thread cost/u)).toBeNull();
  });

  it("keeps a kit's toolbar chip in the row and its menu controls behind one menu", () => {
    const { onSelectAccess } = renderFooter();
    expect(screen.getByRole("button", { name: "Kit chip" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Access" })).toBeNull();
    const trigger = screen.getByLabelText("More composer controls");
    expect(trigger.dataset.composerShortcut?.split(" ")).toContain("composer.mode");
    fireEvent.click(trigger);
    const menu = screen.getByRole("dialog", { name: "More composer controls" });
    const access = within(menu).getByRole("group", { name: "Access" });
    expect(within(access).getByRole("radio", { name: "Full access" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(access).getByRole("radio", { name: "Ask before edits" }));
    expect(onSelectAccess).toHaveBeenCalledWith("ask");
    // A pick closes the menu.
    expect(screen.queryByRole("dialog", { name: "More composer controls" })).toBeNull();
  });

  it("offers the reasoning levels from the text", () => {
    renderFooter();
    fireEvent.click(screen.getByLabelText("Reasoning: Medium"));
    expect(screen.getByRole("menuitem", { name: /High/u })).toBeTruthy();
  });

  it("shows no reasoning level for a model that has none", () => {
    const { registry } = createKitHarness();
    render(
      <TestProviders>
        <WorkbenchShellContext.Provider value={{ registry }}>
          <Composer
            scopeStore={new ComposerScopeStore()}
            snapshot={{ ...snapshot, thinkingLevel: "off", thinkingLevels: ["off"] }}
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
          />
        </WorkbenchShellContext.Provider>
      </TestProviders>,
    );
    expect(screen.queryByLabelText(/^Reasoning/u)).toBeNull();
  });
});
