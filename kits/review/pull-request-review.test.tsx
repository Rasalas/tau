// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROVIDERS, type PendingReviewComment, type RequestService } from "./protocol.js";
import { ReviewComposer } from "./pull-request-review.js";

afterEach(cleanup);

const pending: PendingReviewComment[] = [{ id: "c1", path: "a.go", line: 3, side: "new", body: "Handle this case." }];

function composer(service: RequestService, comments = pending) {
  const onReview = vi.fn(async () => undefined);
  render(<ReviewComposer service={service} events={PROVIDERS[service].capabilities.reviewEvents} pending={comments} onRemovePending={vi.fn()} onComment={vi.fn()} onReview={onReview} onCancel={vi.fn()} />);
  if (comments.length === 0) fireEvent.click(screen.getByRole("tab", { name: "Review" }));
  return { onReview, summary: screen.getByRole("textbox", { name: "Review summary" }), submit: screen.getByRole<HTMLButtonElement>("button", { name: /Submit review/u }) };
}

describe("review summaries", () => {
  it.each([{ count: 0, comments: [] }, { count: 1, comments: pending }])("requires a Forgejo change-request summary with $count line comments", async ({ comments }) => {
    const { onReview, summary, submit } = composer("forgejo", comments);
    fireEvent.click(screen.getByRole("radio", { name: "Request changes" }));
    expect(submit.disabled).toBe(true);
    expect(screen.getByText("Forgejo requires a summary to request changes.")).toBeTruthy();
    fireEvent.change(summary, { target: { value: " \n\t " } });
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    fireEvent.keyDown(summary, { key: "Enter", metaKey: true });
    expect(onReview).not.toHaveBeenCalled();

    fireEvent.change(summary, { target: { value: "  Handle the missing case.  " } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(onReview).toHaveBeenCalledWith("request-changes", "Handle the missing case."));
  });

  it.each(["github", "bitbucket", "azure-devops"] as const)("allows a %s change request with only line comments", async (service) => {
    const { onReview, submit } = composer(service);
    fireEvent.click(screen.getByRole("radio", { name: "Request changes" }));
    expect(submit.disabled).toBe(false);
    expect(screen.queryByText("Forgejo requires a summary to request changes.")).toBeNull();
    fireEvent.click(submit);
    await waitFor(() => expect(onReview).toHaveBeenCalledWith("request-changes", ""));
  });

  it.each(["Comment", "Approve"])("allows a Forgejo %s review with only line comments", async (verdict) => {
    const { onReview, submit } = composer("forgejo");
    fireEvent.click(screen.getByRole("radio", { name: "Request changes" }));
    fireEvent.click(screen.getByRole("radio", { name: verdict }));
    expect(submit.disabled).toBe(false);
    expect(screen.queryByText("Forgejo requires a summary to request changes.")).toBeNull();
    fireEvent.click(submit);
    await waitFor(() => expect(onReview).toHaveBeenCalledWith(verdict.toLowerCase(), ""));
  });
});
