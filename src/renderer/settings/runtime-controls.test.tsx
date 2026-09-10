// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { HostSnapshot } from "../../shared/contracts";
import { SubscriptionLoginIndicator } from "./runtime-controls";

const base = {
  cwd: "/p", sessionId: "s", sessionTitle: "t", models: [], thinkingLevel: "off", thinkingLevels: [],
  messages: [], isStreaming: false, activeTools: [], allTools: [], extensionCount: 0,
} satisfies HostSnapshot;

afterEach(cleanup);

describe("SubscriptionLoginIndicator", () => {
  it("shows only while the active model rides on a subscription login", () => {
    const { rerender } = render(<SubscriptionLoginIndicator snapshot={{ ...base, model: { provider: "anthropic", id: "m", name: "M" } }} />);
    expect(screen.queryByRole("button", { name: "Subscription login warning" })).toBeNull();

    rerender(<SubscriptionLoginIndicator snapshot={{ ...base, model: { provider: "anthropic", id: "m", name: "M", login: "subscription" } }} />);
    expect(screen.getByRole("button", { name: "Subscription login warning" })).toBeTruthy();
  });

  it("opens a detailed popover on hover and keyboard focus", () => {
    render(<SubscriptionLoginIndicator snapshot={{ ...base, model: { provider: "anthropic", id: "m", name: "M", login: "subscription" } }} />);
    const button = screen.getByRole("button", { name: "Subscription login warning" });

    fireEvent.mouseEnter(button.parentElement!);
    expect(screen.getByRole("tooltip").textContent).toMatch(/account may be restricted or banned/u);
    fireEvent.mouseLeave(button.parentElement!);
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.focus(button);
    expect(screen.getByRole("tooltip")).toBeTruthy();
  });
});
