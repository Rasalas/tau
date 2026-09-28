export const RESUME_COMPACTION_EXTENSION_ID = "tau.resume-compaction";

/**
 * Published by the desktop half: `turnOff(runtime)` stops the offer for one
 * runtime (a backend kind, instance included) on every device. A runtime kit
 * calls it when the user says "Don't ask again" to its own resume question.
 */
export const RESUME_COMPACTION_OPT_OUT_SERVICE = "tau.resume-compaction/opt-out";

export interface ResumeCompactionOptOut {
  turnOff(runtime: string): void;
}

/** `values.tau.resume-compaction.off`: the runtimes the offer is off for, as a JSON array. */
export const OFF_KEY = "off";
/** `values.tau.resume-compaction.kept`: the latest "Keep full history" answers, as a JSON array of dismissal keys. */
export const KEPT_KEY = "kept";
