import type { ToolPresentation, UiToolRun } from "tau";

type Tone = ToolPresentation["tone"];

/** The built-in tools the Agent SDK runtime reports under its own names, and the argument each is about. */
const TOOLS: Readonly<Record<string, { glyph: string; tone: Tone; subject: string }>> = {
  Bash: { glyph: "$", tone: "shell", subject: "command" },
  Read: { glyph: "→", tone: "read", subject: "file_path" },
  Glob: { glyph: "→", tone: "read", subject: "pattern" },
  Grep: { glyph: "→", tone: "read", subject: "pattern" },
  Write: { glyph: "±", tone: "write", subject: "file_path" },
  Edit: { glyph: "±", tone: "write", subject: "file_path" },
  MultiEdit: { glyph: "±", tone: "write", subject: "file_path" },
  NotebookEdit: { glyph: "±", tone: "write", subject: "notebook_path" },
  WebFetch: { glyph: "↗", tone: "neutral", subject: "url" },
  WebSearch: { glyph: "↗", tone: "neutral", subject: "query" },
};

function subjectOf(tool: UiToolRun): string | undefined {
  const known = TOOLS[tool.name];
  const value = known ? tool.args[known.subject] : undefined;
  return typeof value === "string" && value.trim() ? value.replaceAll(/\s+/gu, " ").trim() : undefined;
}

/** A call of one of those tools that carries the argument it is about; Pi's lower-case tools never match. */
export function isAgentSdkTool(tool: UiToolRun): boolean {
  return subjectOf(tool) !== undefined;
}

export function presentAgentSdkTool(tool: UiToolRun): ToolPresentation {
  const known = TOOLS[tool.name];
  return {
    glyph: known?.glyph ?? "◇",
    title: tool.name,
    tone: known?.tone ?? "neutral",
    detail: subjectOf(tool) ?? tool.name,
    // A file tool names its file, so the row and trace tabs can open it.
    ...(known?.subject === "file_path" ? { file: subjectOf(tool)! } : {}),
  };
}
