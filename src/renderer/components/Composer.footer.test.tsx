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
    expect(labels.slice(0, 5)).toEqual(["", "Machine", "Project", "|", "GPT-5.6 Luna"]);
  });

  it("draws the model with its marks, the thinking level as text, and a round send", () => {
    renderFooter();
    const model = screen.getByLabelText("Select model: GPT-5.6 Luna");
    expect(model.textContent).toContain("GPT-5.6 Luna");
    expect(model.querySelector(".provider-icon-stack, svg, img")).toBeTruthy();
    const reasoning = screen.getByLabelText("Thinking: Medium");
    expect(reasoning.textContent).toBe("Medium");
    expect(reasoning.querySelectorAll("svg")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Send" }).classList.contains("send-button")).toBe(true);
    // The thread's cost is in its head now, not under the prompt.
    expect(screen.queryByLabelText(/^Thread cost/u)).toBeNull();
  });

  it("keeps optional kit controls behind one menu", () => {
    const { onSelectAccess } = renderFooter();
    expect(screen.queryByRole("button", { name: "Kit chip" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Access" })).toBeNull();
    const trigger = screen.getByLabelText("More composer controls");
    expect(trigger.dataset.composerShortcut?.split(" ")).toContain("composer.mode");
    fireEvent.click(trigger);
    const menu = screen.getByRole("dialog", { name: "More composer controls" });
    expect(within(menu).getByRole("button", { name: "Kit chip" })).toBeTruthy();
    const access = within(menu).getByRole("group", { name: "Access" });
    expect(within(access).getByRole("radio", { name: "Full access" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(access).getByRole("radio", { name: "Ask before edits" }));
    expect(onSelectAccess).toHaveBeenCalledWith("ask");
    // A pick closes the menu.
    expect(screen.queryByRole("dialog", { name: "More composer controls" })).toBeNull();
  });

  it("opens its own menu from the thinking chip (K142): levels, then speed", async () => {
    renderFooter();
    fireEvent.click(screen.getByLabelText("Thinking: Medium"));
    const menu = await screen.findByRole("dialog", { name: "Thinking, context window and speed" });
    const levels = within(menu).getByRole("group", { name: "Thinking" });
    expect(within(levels).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Off", "Low", "MediumDefault", "High"]);
    expect(within(menu).getByRole("group", { name: "Speed" }).textContent).toMatch(/FastPi offers no Fast tier/u);
    expect(screen.getByLabelText("Thinking: Medium").getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Select model" })).toBeNull());
  });

  it("keeps attachment, model, thinking and send directly available", () => {
    renderFooter();
    const row = screen.getByLabelText("Select model: GPT-5.6 Luna").closest(".composer-toolbar") as HTMLElement;
    const labels = [...row.querySelectorAll("button")].map((button) => button.getAttribute("aria-label") ?? button.textContent);
    expect(labels).toEqual(["Attach files", "Machine", "Select model: GPT-5.6 Luna", "Thinking: Medium", "More composer controls", "Context 20 percent used", "Send"]);
    // The ring keeps its percentage in the accessible label and the details.
    expect(screen.getByLabelText("Context 20 percent used").textContent).toBe("");
    fireEvent.click(screen.getByLabelText("More composer controls"));
    const menu = screen.getByRole("dialog", { name: "More composer controls" });
    expect(within(menu).queryByRole("button", { name: /Attach files/u })).toBeNull();
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
    expect(screen.queryByLabelText(/^Thinking/u)).toBeNull();
  });
});

it("keeps the phone's plus menu for attachments and puts other controls in Thread settings", async () => {
  const width = Object.getOwnPropertyDescriptor(window, "innerWidth");
  const profile = document.body.dataset.profile;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  document.body.dataset.profile = "compact";
  try {
    renderFooter();
    expect(screen.queryByRole("button", { name: "More composer controls" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    const attachments = await screen.findByRole("dialog", { name: "Add attachments" });
    expect(within(attachments).getAllByRole("button").map((button) => button.textContent)).toEqual(["Photo Library", "Choose Files"]);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Select model: GPT-5.6 Luna" }));
    const settings = await screen.findByRole("dialog", { name: "Thread settings" });
    expect(within(settings).getByText("Full access")).toBeTruthy();
    expect(within(settings).getByRole("button", { name: /^Thinking and speed/u })).toBeTruthy();
  } finally {
    cleanup();
    if (width) Object.defineProperty(window, "innerWidth", width);
    if (profile === undefined) delete document.body.dataset.profile;
    else document.body.dataset.profile = profile;
  }
});
