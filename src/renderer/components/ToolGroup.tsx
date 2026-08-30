import { memo, useState } from "react";
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
  const showOutput = Boolean(bounded.text) && (running ? !collapsed : collapsed);
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

export function ToolGroup({ tools, registry }: { tools: UiToolRun[]; registry: ExtensionRegistry }) {
  if (tools.length === 0) return null;
  const live = tools.filter((tool) => tool.status === "running").length;
  const done = tools.length - live;

  return (
    <section className="transcript-card">
      <header className="tool-group-header">
        {live > 0 ? <span className="spinner acid small" /> : null}
        <b>{live > 0 ? "RUNNING TOOLS" : "TOOL RUNS"}</b>
        <span>{done} done{live > 0 ? ` · ${live} live` : ""}</span>
      </header>
      {tools.map((tool) => <ToolRun key={tool.id} tool={tool} registry={registry} />)}
    </section>
  );
}
