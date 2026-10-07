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

/** `values.tau.resume-compaction.compact-at`: past which share of its context a Pi thread compacts when its turn ends (design 2i). */
export const COMPACT_AT_KEY = "compact-at";
export const COMPACT_AT_CHOICES = ["60", "80", "never"] as const;
export type CompactAt = (typeof COMPACT_AT_CHOICES)[number];
export const DEFAULT_COMPACT_AT: CompactAt = "80";

export function readCompactAt(raw: unknown): CompactAt | undefined {
  return COMPACT_AT_CHOICES.find((choice) => choice === raw);
}
