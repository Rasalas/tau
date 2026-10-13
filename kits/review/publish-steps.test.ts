import { describe, expect, it, vi } from "vitest";
import { runPublish, stepState, stepWords, type PublishProgress, type PublishStep } from "./publish-steps.js";

function steps(failing?: PublishStep) {
  const calls: PublishStep[] = [];
  let broken = failing;
  const perform = Object.fromEntries((["commit", "push", "create"] as const).map((step) => [step, async () => {
    calls.push(step);
    if (broken === step) throw new Error(`${step} refused`);
  }])) as Record<PublishStep, () => Promise<void>>;
  return { calls, perform, mend: () => { broken = undefined; } };
}

describe("Commit, push & PR steps", () => {
  it("runs commit, push and create in order and reports each one", async () => {
    const { calls, perform } = steps();
    const seen: PublishProgress[] = [];
    await expect(runPublish({ done: [] }, perform, (progress) => seen.push(progress), vi.fn())).resolves.toBe(true);
    expect(calls).toEqual(["commit", "push", "create"]);
    expect(seen.map((progress) => progress.running ?? progress.done.length)).toEqual(["commit", 1, "push", 2, "create", 3]);
  });

  it("stops at the step that fails, names it, and continues there on the next run", async () => {
    const { calls, perform, mend } = steps("push");
    const failure = vi.fn();
    let progress: PublishProgress = { done: [] };
    const keep = (next: PublishProgress) => { progress = next; };
    await expect(runPublish(progress, perform, keep, failure)).resolves.toBe(false);
    expect(failure).toHaveBeenCalledWith("push", expect.objectContaining({ message: "push refused" }));
    expect(progress).toEqual({ done: ["commit"], failed: "push" });
    expect(["commit", "push", "create"].map((step) => stepState(progress, step as PublishStep))).toEqual(["done", "failed", "pending"]);

    mend();
    await expect(runPublish(progress, perform, keep, failure)).resolves.toBe(true);
    // The commit is not made twice.
    expect(calls).toEqual(["commit", "push", "push", "create"]);
  });

  it("words the steps for a pull or a merge request", () => {
    expect(stepWords("create", "MR")).toMatchObject({ pending: "Create MR", running: "Creating MR…", failed: "Creating MR failed" });
    expect(stepWords("commit", "PR").running).toBe("Committing…");
  });
});
