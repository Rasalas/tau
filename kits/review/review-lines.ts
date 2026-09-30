import type { UiDiffLine } from "tau";

/** The side and number a line comment lands on: the new line, else the removed one. */
export function lineTarget(line: UiDiffLine): { line: number; side: "new" | "old" } | undefined {
  if (line.newLine !== undefined) return { line: line.newLine, side: "new" };
  return line.oldLine !== undefined ? { line: line.oldLine, side: "old" } : undefined;
}

/** A diff line as text, for the excerpt that goes with a note. */
export function lineText(line: UiDiffLine): string {
  return `${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "} ${line.text}`;
}

export const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
