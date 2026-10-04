import { parseMarkdown } from "./markdown-pipeline";
import type { Nodes } from "mdast";

export interface VisualizationReference { path: string; mode?: "wide"; title?: string }
export type VisualizationPart = { type: "markdown"; source: string } | { type: "visualization"; reference: VisualizationReference } | { type: "pending" };
const START = "visualize";
const END = "";

/** Installed visualize skill's standalone content reference; never a general HTML directive. */
export function parseVisualizationReference(source: string): VisualizationReference | undefined {
  const line = source.trim();
  if (!line.startsWith(START) || !line.endsWith(END)) return undefined;
  try {
    const value: unknown = JSON.parse(line.slice(START.length, -END.length));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const fields = value as Record<string, unknown>;
    if (typeof fields.path !== "string" || !fields.path || fields.path.length > 8192 || /[\0\r\n]/u.test(fields.path)) return undefined;
    if (fields.mode !== undefined && fields.mode !== "wide") return undefined;
    if (fields.title !== undefined && (typeof fields.title !== "string" || fields.title.length > 250)) return undefined;
    return { path: fields.path, ...(fields.mode === "wide" ? { mode: "wide" } : {}), ...(typeof fields.title === "string" ? { title: fields.title } : {}) };
  } catch { return undefined; }
}

/** Raw source positions retain escaping; Markdown grammar protects fenced and inline code. */
export function splitVisualizationMarkers(source: string, streaming = false): VisualizationPart[] {
  const tail = source.slice(source.lastIndexOf("\n") + 1).trim();
  if (!source.includes(START) && !(streaming && tail.startsWith("") && START.startsWith(tail))) return [{ type: "markdown", source }];
  const matches: Array<{ start: number; end: number; reference?: VisualizationReference }> = [];
  const visit = (node: Nodes) => {
    if (node.type === "code" || node.type === "inlineCode" || node.type === "html") return;
    if (node.type === "paragraph" && node.position) {
      const start = node.position.start.offset!;
      const raw = source.slice(start, node.position.end.offset);
      let offset = start;
      for (const line of raw.split("\n")) {
        const prefix = source.slice(source.lastIndexOf("\n", offset - 1) + 1, offset);
        if (prefix.trim()) { offset += line.length + 1; continue; }
        const reference = parseVisualizationReference(line);
        if (reference) matches.push({ start: offset, end: offset + line.length, reference });
        else if (streaming && offset + line.length === source.length && (line.trim().startsWith(START) || START.startsWith(line.trim())) && line.trim().startsWith("") && !line.includes(END)) matches.push({ start: offset, end: source.length });
        offset += line.length + 1;
      }
      return;
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(parseMarkdown(source));
  const parts: VisualizationPart[] = [];
  let offset = 0;
  for (const match of matches) {
    if (match.start > offset) parts.push({ type: "markdown", source: source.slice(offset, match.start) });
    parts.push(match.reference ? { type: "visualization", reference: match.reference } : { type: "pending" });
    offset = match.end;
  }
  if (offset < source.length || !parts.length) parts.push({ type: "markdown", source: source.slice(offset) });
  return parts;
}
