// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeDiffError, DiffUnavailable } from "./diff-unavailable.js";

afterEach(cleanup);

describe("a diff that did not load", () => {
  it("names a rate limit and its reset, from either wording the host uses", () => {
    expect(describeDiffError("HTTP 403: API rate limit exceeded. The limit resets in about 12 minutes.", "GitHub")).toMatchObject({ title: "GitHub rate limit reached", limited: true });
    expect(describeDiffError("GitLab's rate limit for gitlab.com is reached; Tau asks again in 40 seconds.", "GitLab").description).toContain("Try again in about 40 seconds");
    expect(describeDiffError("HTTP 429 Too Many Requests", "Forgejo").description).toContain("after the limit resets");
  });

  it("does not blame a rate limit for anything else", () => {
    expect(describeDiffError("connection reset", "GitHub")).toEqual({ title: "Could not load the diff", description: "connection reset", limited: false });
  });

  it("offers Retry and Open on the provider", () => {
    const retry = vi.fn();
    const open = vi.fn();
    render(<DiffUnavailable error="boom" provider="Bitbucket" onRetry={retry} onOpen={open} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: /Open on Bitbucket/u }));
    expect(retry).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
  });
});
