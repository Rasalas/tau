// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { usePreferences, type HostSnapshot, type PreferencesStore, type UiThreadUsage, type WorkbenchActions } from "tau";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
import { ExtensionRegistry } from "../../src/renderer/extension-system.js";
import { ThreadStoreContext, WorkbenchShellContext } from "../../src/renderer/workbench-context.js";
import { ThreadStore } from "../../src/workbench/thread-store.js";
import { ThreadCostRow } from "./thread-cost-row.js";

const usage: UiThreadUsage = {
  inputTokens: 12_300,
  outputTokens: 2_100,
  cacheReadTokens: 8_000,
  cacheWriteTokens: 0,
  totalTokens: 22_400,
  costUsd: 0.4231,
  turns: 3,
};

afterEach(cleanup);

function renderRow(spent: UiThreadUsage | undefined, store = new ThreadStore()): PreferencesStore {
  let preferences: PreferencesStore | undefined;
  const Capture = () => { preferences = usePreferences(); return null; };
  const registry = new ExtensionRegistry();
  render(<TestProviders><ThreadStoreContext.Provider value={store}><WorkbenchShellContext.Provider value={{ registry }}>
    <Capture />
    <ThreadCostRow snapshot={{ sessionId: "a", usage: spent } as HostSnapshot} actions={{} as WorkbenchActions} />
  </WorkbenchShellContext.Provider></ThreadStoreContext.Provider></TestProviders>);
  return preferences!;
}

describe("the thread's cost in the project card", () => {
  it("opens compact usage details on click, and dismisses them with Escape", async () => {
    renderRow(usage);
    const row = screen.getByLabelText("Thread cost $0.42");
    expect(row.textContent).toBe("Cost$0.42");
    fireEvent.click(row);
    const popover = await screen.findByRole("dialog", { name: "Thread usage" });
    expect(within(popover).getByText("API cost")).toBeTruthy();
    expect(within(popover).getByText("12.3K")).toBeTruthy();
    expect(within(popover).getByText("Cache read")).toBeTruthy();
    expect(within(popover).getByText("3 turns")).toBeTruthy();
    fireEvent.keyDown(popover, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Thread usage" })).toBeNull();
  });

  it("shows tokens instead of a zero price for a model without pricing", () => {
    renderRow({ ...usage, costUsd: 0 });
    expect(screen.getByLabelText("Thread cost 22.4K tokens")).toBeTruthy();
  });

  it("identifies a plan's value without presenting it as a bill or repeating the amount", async () => {
    renderRow({ ...usage, costUsd: 0, subscription: { ...usage, apiValueUsd: 1.2 } });
    const row = screen.getByLabelText("Thread cost ≈ $1.20");
    expect(row.querySelector(".workspace-card-cost-value.plan")).toBeTruthy();
    fireEvent.mouseEnter(row);
    const popover = await screen.findByRole("dialog", { name: "Thread usage" });
    expect(within(popover).getByText("API equivalent")).toBeTruthy();
    expect(within(popover).getByText("Included in plan")).toBeTruthy();
    expect(within(popover).getAllByText("$1.20")).toHaveLength(1);
    expect(popover.textContent).not.toContain("Billed");
  });

  it("follows surfaced child costs as they change and keeps mixed billing visible", async () => {
    const store = new ThreadStore();
    const child = { id: "child", parentThreadId: "a", path: "child", title: "child", modifiedAt: 1, projectPath: "/repo", projectName: "repo", messageCount: 2, modelProvider: "openai", usage: { ...usage, costUsd: 2 } };
    store.applyThreadIndex({ projects: [], sessions: [child] });
    renderRow({ ...usage, costUsd: 0, subscription: { ...usage, apiValueUsd: 10 } }, store);
    fireEvent.click(screen.getByLabelText("Thread cost ≈ $12.00"));
    const popover = await screen.findByRole("dialog", { name: "Thread usage" });
    expect(within(popover).getByText("API billed")).toBeTruthy();
    expect(within(popover).getByText("Plan value")).toBeTruthy();
    expect(within(popover).getByText("OpenAI")).toBeTruthy();
    expect(within(popover).getAllByText("$10.00")).toHaveLength(1);
    expect(within(popover).getAllByText("$2.00")).toHaveLength(1);
    expect(within(popover).getByText("1 linked subagent")).toBeTruthy();
    act(() => store.applyThreadIndex({ projects: [], sessions: [{ ...child, usage: { ...usage, costUsd: 3 } }] }));
    expect(screen.getByLabelText("Thread cost ≈ $13.00")).toBeTruthy();
    expect(within(popover).getByText("$13.00")).toBeTruthy();
  });

  it("leaves the card alone without usage, and when costs are hidden", () => {
    renderRow(undefined);
    expect(screen.queryByLabelText(/^Thread cost/u)).toBeNull();
    cleanup();
    const preferences = renderRow(usage);
    act(() => preferences.setShowCosts(false));
    expect(screen.queryByLabelText(/^Thread cost/u)).toBeNull();
  });
});
