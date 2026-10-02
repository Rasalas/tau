// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createJuicebarChoices } from "./juicebar-choices.js";
import type { LimitsFeed } from "./limits-feed.js";
import type { UsageLimitAccount, UsageLimitsSummary } from "./protocol.js";
import { createWayLine, planLeft } from "./way-line.js";

afterEach(cleanup);

const NOW = Date.now();
const windows = (weekly: number, session: number): UsageLimitAccount["windows"] => [
  { id: "five_hour", kind: "session", label: "5-hour", usedPercent: session, windowMinutes: 300, resetsAt: NOW + 3_600_000 },
  { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: weekly, windowMinutes: 10_080, resetsAt: NOW + 86_400_000 },
];
const codex: UsageLimitAccount = { id: "codex:account", runtime: "codex", label: "Codex", checkedAt: NOW, windows: windows(35, 58) };
const piPlan: UsageLimitAccount = { id: "pi:openai-codex", runtime: "pi", label: "Pi · openai-codex", checkedAt: NOW, windows: windows(10, 20) };
const summary: UsageLimitsSummary = { checkedAt: NOW, accounts: [codex, piPlan], sources: [] };

describe("the plan line under Runs with", () => {
  it("names what the plan behind a way has left, per runtime and, for Pi, per provider", () => {
    expect(planLeft(summary, {}, "codex", { provider: "openai" }, NOW)).toBe("5-hour 42% left, Weekly 65% left");
    expect(planLeft(summary, {}, "codex@work", { provider: "openai" }, NOW)).toBe("5-hour 42% left, Weekly 65% left");
    expect(planLeft(summary, {}, "pi", { provider: "openai-codex" }, NOW)).toBe("5-hour 80% left, Weekly 90% left");
    // An API key through Pi has no plan; nothing is read yet before the limits arrive.
    expect(planLeft(summary, {}, "pi", { provider: "openai" }, NOW)).toBeUndefined();
    expect(planLeft(undefined, {}, "codex", { provider: "openai" }, NOW)).toBeUndefined();
  });

  it("follows the windows the user chose for the bars, and draws nothing for a way without a plan", () => {
    const codexKey = "\u0000codex\u0000codex:account";
    expect(planLeft(summary, { [`${codexKey}|seven_day`]: false }, "codex", { provider: "openai" }, NOW)).toBe("5-hour 42% left");
    const feed = { subscribe: () => () => undefined, getSnapshot: () => summary } as unknown as LimitsFeed;
    const WayLine = createWayLine(feed, createJuicebarChoices());
    const view = render(<p><WayLine model={{ provider: "openai", id: "gpt", name: "GPT" }} runtime="codex" /></p>);
    expect(screen.getByText(/5-hour 42% left, Weekly 65% left/u).textContent).toBe(" · 5-hour 42% left, Weekly 65% left");
    view.rerender(<p><WayLine model={{ provider: "xai", id: "grok", name: "Grok" }} runtime="grok" /></p>);
    expect(view.container.textContent).toBe("");
  });
});
