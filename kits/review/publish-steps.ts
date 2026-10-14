/** The three steps of "Commit, push & PR", in the order they run. */
export type PublishStep = "commit" | "push" | "create";
export const PUBLISH_STEPS: readonly PublishStep[] = ["commit", "push", "create"];

export interface PublishProgress {
  /** Steps that went through; a retry skips them. */
  done: readonly PublishStep[];
  running?: PublishStep;
  failed?: PublishStep;
}

export type StepState = "pending" | "running" | "done" | "failed";

export const stepState = (progress: PublishProgress, step: PublishStep): StepState =>
  progress.done.includes(step) ? "done" : progress.running === step ? "running" : progress.failed === step ? "failed" : "pending";

/** How a step reads as it waits, runs, went through and failed; `noun` is "PR" or "MR". */
export function stepWords(step: PublishStep, noun: string): Record<StepState, string> {
  if (step === "commit") return { pending: "Commit", running: "Committing…", done: "Committed", failed: "Committing failed" };
  if (step === "push") return { pending: "Push", running: "Pushing…", done: "Pushed", failed: "Pushing failed" };
  return { pending: `Create ${noun}`, running: `Creating ${noun}…`, done: `${noun} created`, failed: `Creating ${noun} failed` };
}

/** Git's diagnostic is readable; the command and remaining output belong in Copy. */
export function publishFailureMessage(step: PublishStep, noun: string, output: string): string {
  const diagnostic = /^\s*(?:fatal|error):\s*(.+)$/imu.exec(output)?.[1]?.trim();
  const reason = diagnostic ?? (output.includes("Command failed:") ? "" : output.split(/\r?\n/u)[0]?.trim());
  const message = `${stepWords(step, noun).failed}${reason ? `: ${reason}` : ""}`;
  return /[.!?]$/u.test(message) ? message : `${message}.`;
}

/**
 * Runs the steps that have not gone through yet, in order, and stops at the first that fails; the
 * next call continues there, so what already worked is never done twice.
 */
export async function runPublish(
  start: PublishProgress,
  perform: Record<PublishStep, () => Promise<void>>,
  report: (progress: PublishProgress) => void,
  failure: (step: PublishStep, error: unknown) => void,
): Promise<boolean> {
  const done = [...start.done];
  for (const step of PUBLISH_STEPS) {
    if (done.includes(step)) continue;
    report({ done: [...done], running: step });
    try {
      await perform[step]();
    } catch (error) {
      report({ done: [...done], failed: step });
      failure(step, error);
      return false;
    }
    done.push(step);
    report({ done: [...done] });
  }
  return true;
}
