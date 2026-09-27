import { describe, expect, it, vi } from "vitest";
import type { SubmissionControllerPorts } from "./submission-controller";
import { deferredSubmission } from "./deferred-submission";

describe("deferredSubmission", () => {
  it("loads the controller on the first send and hands every send to it", async () => {
    const run = vi.fn(async () => "not now");
    const ports = {
      registry: { findSlashCommand: (text: string) => ({ command: { run }, args: text }) },
      actions: () => ({}),
    } as unknown as SubmissionControllerPorts;
    const submission = deferredSubmission(ports);
    await expect(submission.submit({ text: "/one" })).resolves.toEqual({ accepted: false, message: "not now" });
    await expect(submission.submit({ text: "/two" })).resolves.toEqual({ accepted: false, message: "not now" });
    expect(run.mock.calls.map(([args]) => args)).toEqual(["/one", "/two"]);
  });
});
