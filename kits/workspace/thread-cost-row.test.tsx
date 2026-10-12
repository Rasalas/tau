// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { usePreferences, type HostSnapshot, type PreferencesStore, type UiThreadUsage, type WorkbenchActions } from "tau";
import { TestProviders } from "../../src/renderer/test-support/test-providers.js";
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

function renderRow(spent: UiThreadUsage | undefined): PreferencesStore {
  let preferences: PreferencesStore | undefined;
  const Capture = () => { preferences = usePreferences(); return null; };
  render(<TestProviders>
    <Capture />
    <ThreadCostRow snapshot={{ sessionId: "a", usage: spent } as HostSnapshot} actions={{} as WorkbenchActions} />
  </TestProviders>);
  return preferences!;
}

describe("the thread's cost in the project card", () => {
  it("shows what the thread has spent, with its split in the tooltip", () => {
    renderRow(usage);
    const row = screen.getByLabelText("Thread cost $0.42");
    expect(row.textContent).toBe("Cost$0.42");
    expect(row.getAttribute("data-tooltip")).toBe("Spent $0.42\n12.3k in · 2.1k out · 8.0k cache read · 3 turns");
  });

  it("shows tokens instead of a zero price for a model without pricing", () => {
    renderRow({ ...usage, costUsd: 0 });
    expect(screen.getByLabelText("Thread cost 22.4k tok")).toBeTruthy();
  });

  it("shows a subscription's usage apart, quieter, with what the API would have charged", () => {
    renderRow({ ...usage, costUsd: 0, subscription: { ...usage, apiValueUsd: 1.2 } });
    const row = screen.getByLabelText("Thread cost $1.20");
    expect(row.querySelector(".workspace-card-cost-value.plan")).toBeTruthy();
    expect(row.getAttribute("data-tooltip")).toBe("Subscription: included\n12.3k in · 2.1k out · 8.0k cache read · 3 turns\nWould have cost ≈ $1.20 via the API");
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
