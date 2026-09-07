// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { HostSnapshot } from "../../shared/contracts";
import { SubscriptionLoginStatus } from "./runtime-controls";

const base = {
  cwd: "/p", sessionId: "s", sessionTitle: "t", models: [], thinkingLevel: "off", thinkingLevels: [],
  messages: [], isStreaming: false, activeTools: [], allTools: [], extensionCount: 0,
} satisfies HostSnapshot;

afterEach(cleanup);

describe("SubscriptionLoginStatus", () => {
  it("shows only while the active model rides on a subscription login", () => {
    const actions = {} as never;
    render(<SubscriptionLoginStatus snapshot={{ ...base, model: { provider: "anthropic", id: "m", name: "M" } }} actions={actions} />);
    expect(screen.queryByText("Subscription login")).toBeNull();
    cleanup();
    render(<SubscriptionLoginStatus snapshot={{ ...base, model: { provider: "anthropic", id: "m", name: "M", login: "subscription" } }} actions={actions} />);
    expect(screen.getByText("Subscription login").closest("span")?.getAttribute("title")).toMatch(/without notice/u);
  });
});
