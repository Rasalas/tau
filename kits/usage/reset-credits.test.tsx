// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UsageLimits } from "./limits.js";
import type { UsageLimitsSummary } from "./protocol.js";
afterEach(cleanup);
const now = Date.now();
const limits: UsageLimitsSummary = { checkedAt: now, sources: [], accounts: [{ id: "codex:account", runtime: "codex", label: "Codex", checkedAt: now, windows: [{ id: "primary", kind: "session", label: "5-hour", usedPercent: 100 }], resetCredits: { availableCount: 2, nextExpiresAt: now + 60_000 } }] };
it("confirms the account write, disables duplicate clicks and reports uncertainty", async () => {
  let resolve!: (answer: string) => void;
  const redeem = vi.fn(() => new Promise<string>((done) => { resolve = done; }));
  render(<UsageLimits limits={limits} error={undefined} now={now} onRedeemReset={redeem} />);
  fireEvent.click(screen.getByRole("button", { name: "Use reset" }));
  expect(redeem).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm reset" }));
  expect(redeem).toHaveBeenCalledWith(limits.accounts[0]);
  expect(screen.getByRole("button", { name: "Applying reset…" }).hasAttribute("disabled")).toBe(true);
  resolve("Reset applied.");
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Reset applied."));
});
it("does not offer expired resets or unavailable platform credentials", () => {
  render(<UsageLimits limits={{ ...limits, accounts: [{ ...limits.accounts[0]!, resetCredits: { availableCount: 2, nextExpiresAt: now - 1 } }] }} error={undefined} now={now} onRedeemReset={vi.fn()} />);
  expect(screen.queryByRole("button", { name: "Use reset" })).toBeNull();
});
it("offers checking a persisted uncertain attempt even when no credits remain", () => {
  render(<UsageLimits limits={{ ...limits, accounts: [{ ...limits.accounts[0]!, resetCredits: { availableCount: 0, pending: true } }] }} error={undefined} now={now} onRedeemReset={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Check reset" })).toBeTruthy();
});
