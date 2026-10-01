// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, UiQueuedMessage } from "../../shared/contracts";
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

function renderFooter(onSelectAccess = vi.fn(), lead?: React.ReactNode, contextPercent = 20, queue: readonly UiQueuedMessage[] = []) {
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
      context.registerComposerControl({ id: "test.machine", placement: "lead", Component: () => <button type="button" className="runtime-chip">Machine</button> });
    },
  });
  render(
    <TestProviders>
      <WorkbenchShellContext.Provider value={{ registry }}>
        <Composer
          scopeStore={new ComposerScopeStore()}
          snapshot={snapshot}
          queue={queue}
          contextUsage={{ tokens: contextPercent * 1_000, contextWindow: 100_000, percent: contextPercent }}
          contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
          textareaRef={createRef<HTMLTextAreaElement>()}
          onSubmit={vi.fn(async () => ({ accepted: true as const }))}
          onAbort={() => {}}
          onCancelQueued={() => {}}
          onSteerQueued={() => {}}
          onSetModel={() => {}}
          onSetThinking={() => {}}
          onCompactContext={() => {}}
          lead={lead}
        />
      </WorkbenchShellContext.Provider>
    </TestProviders>,
  );
  return { onSelectAccess };
}

describe("the composer's slim footer", () => {
  it("leads with the kits' lead controls, then core's lead, a rule, and the model (a new thread's machine and project)", () => {
    renderFooter(vi.fn(), <button type="button">Project</button>);
    const row = screen.getByText("Machine").closest(".composer-chips") as HTMLElement;
    const labels = [...row.querySelectorAll("button, .composer-lead-rule")].map((node) => node.classList.contains("composer-lead-rule") ? "|" : node.textContent);
    expect(labels.slice(0, 4)).toEqual(["Machine", "Project", "|", "GPT-5.6 Luna"]);
  });

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

  it("opens the picker at its thinking column from the reasoning level", async () => {
    renderFooter();
    fireEvent.click(screen.getByLabelText("Reasoning: Medium"));
    const levels = await screen.findByRole("radiogroup", { name: /^Thinking for/u });
    expect(within(levels).getByRole("radio", { name: /High/u })).toBeTruthy();
    await waitFor(() => expect(levels.contains(document.activeElement)).toBe(true));
    expect(screen.getByLabelText("Reasoning: Medium").getAttribute("aria-expanded")).toBe("true");
  });

  it("draws the design's row: model, reasoning, the menu, the context meter and send; attach waits in the menu", () => {
    renderFooter();
    const row = screen.getByLabelText("Select model: GPT-5.6 Luna").closest(".composer-toolbar") as HTMLElement;
    const labels = [...row.querySelectorAll("button")].map((button) => button.getAttribute("aria-label") ?? button.textContent);
    expect(labels).toEqual(["Machine", "Select model: GPT-5.6 Luna", "Reasoning: Medium", "Kit chip", "More composer controls", "Context 20 percent used", "Send"]);
    // The meter says its share, as design 1a writes "19%".
    expect(screen.getByLabelText("Context 20 percent used").textContent).toBe("20%");
    fireEvent.click(screen.getByLabelText("More composer controls"));
    const menu = screen.getByRole("dialog", { name: "More composer controls" });
    expect(within(menu).getByRole("button", { name: /Attach files/u })).toBeTruthy();
  });

  it("says how many follow-ups wait, at the row's end before send", () => {
    renderFooter(vi.fn(), undefined, 20, [{ id: "q1", text: "and then the tests", attachments: 0 }]);
    const row = screen.getByLabelText("Select model: GPT-5.6 Luna").closest(".composer-chips") as HTMLElement;
    expect(row.querySelector(".composer-queued")?.textContent).toBe("1 queued");
  });

  it("keeps send in view with nothing to send, resting until there is a draft", () => {
    renderFooter();
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.dataset.tooltip).toMatch(/⇧↵ newline, \$ skills, \/ commands, @ files/u);
    fireEvent.change(screen.getByPlaceholderText("Ask anything, or hand it work…"), { target: { value: "go" } });
    expect(send.disabled).toBe(false);
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
