// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { UiThreadUsage } from "../../shared/contracts";
import { ThreadCost } from "./ThreadCost";

const usage: UiThreadUsage = {
  inputTokens: 12_300,
  outputTokens: 2_100,
  cacheReadTokens: 8_000,
  cacheWriteTokens: 0,
  totalTokens: 22_400,
  costUsd: 0.4231,
  turns: 3,
};

function renderCost(spent: UiThreadUsage) {
  render(<ThreadCost usage={spent} className="thread-detail" />);
}

afterEach(cleanup);

describe("thread cost in the thread's details", () => {
  it("shows what the thread has spent, and its split when opened", async () => {
    renderCost(usage);
    const button = screen.getByLabelText("Thread cost $0.42");
    expect(button.textContent).toBe("$0.42");

    fireEvent.click(button);
    expect(await screen.findByText("12.3k in · 2.1k out · 8.0k cache read · 3 turns")).toBeTruthy();
  });

  it("shows tokens instead of a zero price for a model without pricing", () => {
    renderCost({ ...usage, costUsd: 0 });
    expect(screen.getByLabelText("Thread cost 22.4k tok")).toBeTruthy();
  });

  it("shows a subscription's usage apart, with what the API would have charged", async () => {
    renderCost({ ...usage, costUsd: 0, subscription: { ...usage, apiValueUsd: 1.2 } });
    const button = screen.getByLabelText("Thread cost $1.20");
    fireEvent.click(button);
    expect(await screen.findByText("Subscription")).toBeTruthy();
    expect(screen.getByText("Would have cost ≈ $1.20 via the API")).toBeTruthy();
    expect(screen.queryByText("Spent")).toBeNull();
  });
});
