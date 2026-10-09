import type { ThreadRowStatus } from "tau";
import type { ThreadRowStatusMark } from "./protocol.js";

export type MarkedRowStatus = ThreadRowStatus & { icon?: ThreadRowStatusMark["icon"] };

/** A row's state with another kit's mark: a background mark only stands in for an idle or ready row. */
export function markedRowStatus(base: ThreadRowStatus, mark: ThreadRowStatusMark | undefined): MarkedRowStatus {
  if (!mark) return base;
  const { tone, ...shown } = mark;
  if (tone !== "background") return { ...shown, activity: "waiting" };
  return base.activity === "idle" || base.activity === "ready" ? { ...shown, activity: "background" } : base;
}

/** The threads whose marks ask for the user; sections treat them as questions. */
export function attentionMarks(marks: Readonly<Record<string, ThreadRowStatusMark>>): string[] {
  return Object.entries(marks).filter(([, mark]) => mark.tone !== "background").map(([id]) => id);
}
