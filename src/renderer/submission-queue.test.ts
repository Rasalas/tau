import { describe, expect, it } from "vitest";
import { shouldQueueSubmission, formatQueuedFollowUp } from "./submission-queue";

describe("submission-queue", () => {
  it("determines when to queue follow up submissions", () => {
    // Normal case during streaming turn: queues as follow-up
    expect(
      shouldQueueSubmission({
        isPendingNewThread: false,
        hasSnapshot: true,
        visibleStreaming: true,
        delivery: "followUp",
      }),
    ).toBe(true);

    // Steer messages are not queued as follow-ups
    expect(
      shouldQueueSubmission({
        isPendingNewThread: false,
        hasSnapshot: true,
        visibleStreaming: true,
        delivery: "steer",
      }),
    ).toBe(false);

    // New thread drafts are never queued as follow-ups
    expect(
      shouldQueueSubmission({
        isPendingNewThread: true,
        hasSnapshot: true,
        visibleStreaming: true,
      }),
    ).toBe(false);

    // Idle thread does not queue
    expect(
      shouldQueueSubmission({
        isPendingNewThread: false,
        hasSnapshot: true,
        visibleStreaming: false,
      }),
    ).toBe(false);
  });

  it("formats queued follow up items", () => {
    const item = formatQueuedFollowUp("Follow up prompt", [{ kind: "image", name: "img.png", mimeType: "image/png", data: "data", size: 1024 }]);
    expect(item.text).toBe("Follow up prompt");
    expect(item.attachments).toHaveLength(1);
  });
});
