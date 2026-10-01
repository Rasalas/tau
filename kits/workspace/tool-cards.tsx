import { FileText, Folder, Pencil, Search } from "lucide-react";
import type { ToolPresentation, UiToolRun } from "tau";

export interface DiffLine {
  sign: "+" | "-";
  text: string;
}

/** Lines of a diff the card shows before it says how many more there are. */
const SHOWN_LINES = 40;

const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const lines = (value: string): string[] => value ? value.replace(/\n$/u, "").split("\n") : [];

/** The lines one replacement changes: what the two texts share at either end is left out. */
function replaced(before: string, after: string): DiffLine[] {
  const old = lines(before);
  const next = lines(after);
  let head = 0;
  while (head < old.length && head < next.length && old[head] === next[head]) head += 1;
  let tail = 0;
  while (tail < old.length - head && tail < next.length - head && old[old.length - 1 - tail] === next[next.length - 1 - tail]) tail += 1;
  return [
    ...old.slice(head, old.length - tail).map((line): DiffLine => ({ sign: "-", text: line })),
    ...next.slice(head, next.length - tail).map((line): DiffLine => ({ sign: "+", text: line })),
  ];
}

/**
 * What a file call changed, from its arguments: Pi's `edits[]`, the Agent SDK's
 * `old_string`/`new_string` (also in `edits[]`), a write's `content`; else the
 * `+`/`-` lines of a patch the runtime printed (OpenCode, Codex).
 */
export function editLines(tool: UiToolRun): DiffLine[] | undefined {
  const args = tool.args;
  const edits = (Array.isArray(args.edits) ? args.edits : [args]) as Array<Record<string, unknown>>;
  const pairs = edits.flatMap((edit) => {
    const before = text(edit.oldText) ?? text(edit.old_string);
    const after = text(edit.newText) ?? text(edit.new_string);
    return before !== undefined && after !== undefined ? [[before, after] as const] : [];
  });
  const content = text(args.content);
  if (pairs.length === 0 && content !== undefined) pairs.push(["", content]);
  if (pairs.length > 0) return pairs.flatMap(([before, after]) => replaced(before, after));
  const patch = tool.output ?? "";
  if (!/^@@ /mu.test(patch)) return undefined;
  return patch.split("\n").flatMap((line): DiffLine[] => /^([+-])(?!\1\1 )/u.test(line) ? [{ sign: line[0] as "+" | "-", text: line.slice(1) }] : []);
}

function EditBody({ diff }: { diff: readonly DiffLine[] }) {
  return <div className="tool-diff">
    {diff.slice(0, SHOWN_LINES).map((line, index) => <div key={index} className={line.sign === "+" ? "add" : "del"}>{line.sign} {line.text}</div>)}
    {diff.length > SHOWN_LINES ? <div className="more">… {diff.length - SHOWN_LINES} more lines</div> : null}
  </div>;
}

const path = (tool: UiToolRun): string | undefined => text(tool.args.path) ?? text(tool.args.file_path);

/** The file tools of every runtime, by the names they report. */
export const WRITE_TOOLS = new Set(["edit", "write", "Edit", "Write", "MultiEdit"]);
export const READ_TOOLS = new Set(["read", "grep", "find", "ls", "Read"]);

/** An edit as the design's card: "✎ Edit <path> +4 −2" over its diff (design 1f). */
export function presentWrite(tool: UiToolRun): ToolPresentation {
  const file = path(tool);
  const diff = tool.status === "error" ? undefined : editLines(tool);
  const added = diff?.filter((line) => line.sign === "+").length ?? 0;
  return {
    glyph: <Pencil size={13} />,
    title: /^write$/iu.test(tool.name) ? "Write" : "Edit",
    tone: "write",
    detail: file ?? "file mutation",
    ...(file ? { file } : {}),
    ...(diff?.length ? {
      note: <span className="tool-diff-stat"><span className="stat-add">+{added}</span> <span className="stat-del">−{diff.length - added}</span></span>,
      body: <EditBody diff={diff} />,
    } : {}),
  };
}

export function presentRead(tool: UiToolRun): ToolPresentation {
  const read = /^read$/iu.test(tool.name);
  const file = read ? path(tool) : undefined;
  return {
    glyph: read ? <FileText size={13} /> : tool.name === "ls" ? <Folder size={13} /> : <Search size={13} />,
    title: read ? "Read" : tool.name,
    tone: "read",
    detail: String(path(tool) ?? tool.args.pattern ?? tool.args.query ?? "workspace"),
    ...(file ? { file } : {}),
  };
}
