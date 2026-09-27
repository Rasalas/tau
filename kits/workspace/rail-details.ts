import type { UiSession } from "tau";
import type { TurnStat } from "./protocol.js";

export function diffStatLabel(stat: TurnStat): string {
  return `+${stat.added} −${stat.removed}`;
}

/**
 * What the row's hover card says, line by line (T3 Code's thread tooltip):
 * the title, the project, the branch, the state and the last turn's changes.
 */
export function threadDetails({ session, status, hint, age, stat, machine }: {
  session: UiSession;
  /** Another machine the thread runs on. */
  machine?: string;
  /** The row's own state word, e.g. "Working"; idle rows pass none. */
  status?: string;
  hint?: string;
  age: string;
  stat?: TurnStat;
}): string {
  const lines = [session.title, session.projectName];
  if (machine) lines.push(`Runs on ${machine}`);
  if (session.projectLabel) lines.push(`On ${session.projectLabel}`);
  const updated = age === "now" ? "just now" : /^\d+[mhd]$/u.test(age) ? `${age} ago` : `on ${age}`;
  lines.push(status ? (hint ? `${status}: ${hint}` : status) : `Updated ${updated}`);
  if (stat) lines.push(`Last turn ${diffStatLabel(stat)} in ${stat.files} file${stat.files === 1 ? "" : "s"}`);
  return lines.join("\n");
}
