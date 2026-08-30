import { ChevronRight, Hammer } from "lucide-react";
import { memo, useEffect, useState } from "react";
import type { UiToolRun } from "../../shared/contracts";
import type { ExtensionRegistry } from "../extension-system";
import { ACTIVE_TOOL_OUTPUT_LIMIT, SETTLED_TOOL_OUTPUT_LIMIT, boundToolOutput } from "../tool-output";

function seconds(from: number, to: number): string {
  return `${Math.max(1, Math.round((to - from) / 1000))}s`;
}

const ToolRun = memo(function ToolRun({ tool, registry }: { tool: UiToolRun; registry: ExtensionRegistry }) {
  const running = tool.status === "running";
  // A running tool shows what it has produced so far without needing a click.
  const [collapsed, setCollapsed] = useState(false);
  const view = registry.presentTool(tool);
  const bounded = boundToolOutput(tool.output, running ? ACTIVE_TOOL_OUTPUT_LIMIT : SETTLED_TOOL_OUTPUT_LIMIT);
  const showOutput = view.output !== "hidden" && Boolean(bounded.text) && (running ? !collapsed : collapsed);
  const copyFullOutput = () => {
    if (tool.output) void navigator.clipboard?.writeText(tool.output);
  };

  return (
    <div className={`tool-run tone-${view.tone}`}>
      <button className="tool-run-line" onClick={() => setCollapsed((value) => !value)}>
        <span className="tool-run-glyph">{view.glyph}</span>
        <span className="tool-run-name">{view.title}</span>
        <span className="tool-run-detail" title={view.detail}>{view.detail}</span>
        <span className={`tool-run-state ${tool.status}`}>
          {running
            ? seconds(tool.startedAt, Date.now())
            : tool.status === "error"
              ? "!"
              : tool.endedAt ? seconds(tool.startedAt, tool.endedAt) : "✓"}
        </span>
      </button>
      {showOutput ? (
        <pre className="tool-output">
          {bounded.truncated ? (
            <button className="tool-output-truncated" onClick={(event) => { event.stopPropagation(); copyFullOutput(); }}>
              … earlier output hidden · copy full output
            </button>
          ) : null}
          {bounded.text}
        </pre>
      ) : null}
    </div>
  );
});

function activitySummary(tools: UiToolRun[], live: number): string {
  const commands = tools.filter((tool) => tool.name === "bash" || tool.name === "powershell").length;
  const otherTools = tools.length - commands;
  const toolLabel = `${otherTools} ${otherTools === 1 ? "tool" : "tools"}`;
  const commandLabel = `${commands} ${commands === 1 ? "command" : "commands"}`;
  if (live > 0) {
    const counts = commands > 0 && otherTools > 0
      ? `${toolLabel} and ${commandLabel}`
      : commands > 0 ? commandLabel : toolLabel;
    return `Using ${counts} · ${live} running`;
  }
  if (commands > 0 && otherTools > 0) return `Used ${toolLabel} and ran ${commandLabel}`;
  if (commands > 0) return `Ran ${commandLabel}`;
  return `Used ${toolLabel}`;
}

export function ToolGroup({ tools, registry }: { tools: UiToolRun[]; registry: ExtensionRegistry }) {
  const live = tools.filter((tool) => tool.status === "running").length;
  const [expanded, setExpanded] = useState(live > 0);
  useEffect(() => setExpanded(live > 0), [live]);
  if (tools.length === 0) return null;
  const summary = activitySummary(tools, live);

  return (
    <section className={`tool-activity${expanded ? " expanded" : ""}`}>
      <button
        type="button"
        className="tool-activity-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {live > 0 ? <span className="spinner acid small" /> : <Hammer size={16} strokeWidth={1.7} />}
        <span>{summary}</span>
        <ChevronRight className="activity-chevron" size={14} />
      </button>
      {expanded ? (
        <div className="tool-activity-detail">
          {tools.map((tool) => <ToolRun key={tool.id} tool={tool} registry={registry} />)}
        </div>
      ) : null}
    </section>
  );
}
