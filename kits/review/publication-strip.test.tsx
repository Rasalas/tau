// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PublicationStrip } from "./publication-strip.js";
afterEach(cleanup);
it("links the published commit and removes stale proof on thread switches and new turns", async () => {
  const value = { commit: "1234567890abcdef", target: "origin/main", url: "https://github.com/a/b/commit/1234567890abcdef" };
  let resolve!: (value: unknown) => void;
  const host = { invoke: vi.fn().mockResolvedValueOnce(value).mockImplementationOnce(() => new Promise((done) => { resolve = done; })), onEvent: () => () => undefined };
  const { rerender } = render(<PublicationStrip host={host} threadId="one" streaming={false} />);
  expect((await screen.findByRole("link", { name: "Open commit 12345678 on origin/main" })).getAttribute("href")).toBe(value.url);
  rerender(<PublicationStrip host={host} threadId="two" streaming={false} />);
  expect(screen.queryByRole("link")).toBeNull();
  resolve(value);
  await screen.findByRole("link");
  rerender(<PublicationStrip host={host} threadId="two" streaming />);
  await waitFor(() => expect(screen.queryByRole("link")).toBeNull());
});
