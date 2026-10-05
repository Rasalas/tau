// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SettlementStrip } from "./settlement-strip.js";
import { SettlementSource } from "./settlement.js";
afterEach(cleanup);
it("shows the stored settlement reason and reopens the named thread", () => {
  const source = new SettlementSource();
  const meta = { settledAt: 1, settledBy: "pr-merged", settledForRequest: "https://github.com/a/b/pull/42" };
  const release = vi.fn();
  const service = { get: () => meta, subscribe: () => () => undefined, reopen: vi.fn(), claimNote: vi.fn(() => release) };
  source.set(service);
  const view = render(<SettlementStrip source={source} threadId="thread" />);
  expect(screen.getByRole("status").textContent).toContain("Settled · PR #42 merged");
  expect(screen.getByRole("link", { name: "PR #42" }).getAttribute("href")).toBe(meta.settledForRequest);
  fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
  expect(service.reopen).toHaveBeenCalledWith("thread");
  expect(service.claimNote).toHaveBeenCalledWith("thread");
  view.unmount();
  expect(release).toHaveBeenCalledOnce();
});
