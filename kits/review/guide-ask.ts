import type { GuideStop } from "./guide-protocol.js";
import { ATTENTION_LABELS } from "./guide-tour.js";
import type { ReviewCommentChip } from "./protocol.js";

const LABEL_MAX = 40;

/** What the composer's chip says about a stop: the stop in the guide's words, then what the reader asks. */
export function askChip(request: { noun: string; number: number }, stop: GuideStop, index: number, count: number, question: string): ReviewCommentChip {
  const title = stop.title.length > LABEL_MAX ? `${stop.title.slice(0, LABEL_MAX - 1)}…` : stop.title;
  const parts = [`Stop ${index + 1} of ${count}: ${stop.title}`];
  if (stop.summary.trim()) parts.push(stop.summary.trim());
  if (stop.attention) parts.push(`${ATTENTION_LABELS[stop.attention.kind]}: ${stop.attention.note}`);
  if (stop.excerpts.length > 0) {
    parts.push(`Lines it shows:\n${stop.excerpts.map((excerpt) => `- ${excerpt.path}:${excerpt.start}-${excerpt.end}${excerpt.side === "old" ? " (before the change)" : ""}`).join("\n")}`);
  }
  if (question.trim()) parts.push(`Question: ${question.trim()}`);
  return {
    kind: "text-excerpt",
    label: `Stop ${index + 1}: ${title}`,
    payload: { source: `Review guide of ${request.noun} #${request.number}`, text: parts.join("\n\n") },
  };
}
