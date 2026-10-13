import { Braces, MousePointerClick } from "lucide-react";
import type { ToolPresentation, UiToolRun } from "tau";

/**
 * The JavaScript REPL tool under the names it arrives with: a dynamic call
 * (`js`, or `<namespace>.js`) and an MCP call (`mcp__<server>__js`).
 */
const REPL_TOOLS = new Set(["js", "cua_repl.js", "node_repl.js", "mcp__cua_repl__js", "mcp__node_repl__js"]);
/** A REPL that drives the screen says so in its code, whichever server runs it. */
const SCREEN_CODE = /\bsky\s*\.|["']@oai\/sky["']/u;

const codeOf = (tool: UiToolRun): string | undefined => typeof tool.args.code === "string" ? tool.args.code : undefined;

/** A REPL call that carries code; a tool that merely shares the name `js` keeps its default row. */
export function isReplTool(tool: UiToolRun): boolean {
  return REPL_TOOLS.has(tool.name) && codeOf(tool) !== undefined;
}

function drivesScreen(tool: UiToolRun): boolean {
  return tool.name.includes("cua_repl") || SCREEN_CODE.test(codeOf(tool) ?? "");
}

/** The row names the action; its code stays behind the row, with the output below it. */
export function presentRepl(tool: UiToolRun): ToolPresentation {
  const screen = drivesScreen(tool);
  const title = typeof tool.args.title === "string" ? tool.args.title.replaceAll(/\s+/gu, " ").trim() : "";
  const code = codeOf(tool)!;
  // A body replaces the output, which the host holds back over 16 KB; then only the default row can load it.
  const held = tool.outputDeferred === true && tool.output === undefined;
  return {
    glyph: screen ? <MousePointerClick size={13} /> : <Braces size={13} />,
    title: screen ? "Computer use" : "Run JavaScript",
    tone: "neutral",
    detail: title,
    ...(code.trim() && !held ? {
      body: (
        <div>
          <pre className="tool-output">{code}</pre>
          {tool.output ? <pre className="tool-output">{tool.output}</pre> : null}
        </div>
      ),
    } : {}),
  };
}
